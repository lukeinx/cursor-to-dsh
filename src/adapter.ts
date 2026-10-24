/**
 * The DSH `LlmAdapter` for the `cursor` route.
 *
 * `stream()` converts the request, runs one call on the session's Cursor agent and yields
 * its chunks. The model catalog comes from the Cursor SDK and is cached; without a key the
 * fallback list is offered so the route stays selectable.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";

import { FALLBACK_MODELS, PROVIDER_ID, contextWindow, modelNames, reasoningInfo, type CatalogModel } from "./models.ts";
import type { Image } from "./prompt.ts";
import { ChunkQueue, Reply } from "./reply.ts";
import { debug, runTurn, sessionKeyFor } from "./session.ts";
import { imageRefs, readRequest } from "./transcript.ts";

const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 60_000;
/** Attachments are immutable, and every request carries the whole history: read each once. */
const IMAGE_CACHE_SIZE = 64;

export interface AdapterDeps {
  createAgent: (opts: any) => Promise<any>;
  listModels: (opts: { apiKey: string }) => Promise<CatalogModel[]>;
  resolveApiKey: () => Promise<string | undefined>;
  cwdFor: (sessionId: string | undefined) => string;
  /** Base64 bytes of one image attachment; undefined when no attachment service is mounted. */
  readImage?: (ref: any, signal?: AbortSignal) => Promise<Image | undefined>;
  /** Called once a live catalog proves the key works; pays the SDK's per-process setup early. */
  prewarm?: (opts: { apiKey: string; modelId: string }) => void;
}

export class CursorAdapter extends LlmAdapter {
  private readonly deps: AdapterDeps;
  private catalog: { models: CatalogModel[]; live: boolean; at: number } | undefined;
  private loading: Promise<CatalogModel[]> | undefined;
  private readonly images = new Map<string, Image>();

  constructor(deps: AdapterDeps) {
    super();
    this.deps = deps;
  }

  override providerInfo(provider: string): any {
    return { id: provider, name: "Cursor" };
  }

  override async listModels(provider: string): Promise<any[]> {
    const models = await this.models();
    const names = modelNames(models);
    return models.map((m) => ({ provider, id: m.id, name: names.get(m.id), inputModalities: this.modalities() }));
  }

  override async resolveModel(provider: string, model: string): Promise<any> {
    const models = await this.models();
    const m = models.find((c) => c.id === model);
    const info: any = {
      provider,
      id: model,
      name: modelNames(models).get(model) ?? model,
      inputModalities: this.modalities(),
      context: { contextWindow: contextWindow(m) },
      systemPromptUpdate: "in-history",
    };
    const reasoning = reasoningInfo(m);
    if (reasoning) info.reasoning = reasoning;
    return info;
  }

  override async *stream(options: any): AsyncIterable<any> {
    if (options?.stop?.length) throw new LlmError("Cursor does not support stop sequences", "UNSUPPORTED_OPTION");
    const [model, apiKey, images] = await Promise.all([this.find(options.model), this.deps.resolveApiKey(), this.loadImages(options)]);
    const transcript = readRequest(options, images);
    const sessionId = typeof options.sessionId === "string" ? options.sessionId : undefined;
    const queue = new ChunkQueue();
    void runTurn({
      model: { id: options.model, cursorParameters: model?.parameters },
      transcript,
      reasoning: options.reasoningEffort,
      signal: options.signal,
      apiKey,
      sessionKey: sessionKeyFor(sessionId, transcript, options.purpose),
      cwd: this.deps.cwdFor(sessionId),
      deps: { createAgent: this.deps.createAgent },
      reply: new Reply(queue),
    });
    yield* queue;
  }

  private modalities(): string[] {
    return this.deps.readImage ? ["text", "image"] : ["text"];
  }

  private async loadImages(options: any): Promise<Map<string, Image>> {
    const out = new Map<string, Image>();
    const read = this.deps.readImage;
    if (!read) return out;
    await Promise.all(
      imageRefs(options).map(async (ref) => {
        const id = String(ref.attachmentId);
        let image = this.images.get(id);
        if (!image) {
          try {
            image = await read(ref, options.signal);
          } catch (err) {
            debug(`image ${id} unreadable: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (image) {
            this.images.set(id, image);
            if (this.images.size > IMAGE_CACHE_SIZE) this.images.delete(this.images.keys().next().value!);
          }
        }
        if (image) out.set(id, image);
      }),
    );
    return out;
  }

  /** Catalog entry for a model id; unknown ids still route, without Cursor params. */
  private async find(id: string): Promise<CatalogModel | undefined> {
    return (await this.models()).find((m) => m.id === id);
  }

  private async models(): Promise<CatalogModel[]> {
    const c = this.catalog;
    if (c && Date.now() - c.at < (c.live ? CATALOG_TTL_MS : CATALOG_RETRY_MS)) return c.models;
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async load(): Promise<CatalogModel[]> {
    let models: CatalogModel[] = [];
    let apiKey: string | undefined;
    try {
      apiKey = await this.deps.resolveApiKey();
      if (apiKey) models = (await this.deps.listModels({ apiKey })) ?? [];
    } catch (err) {
      debug(`catalog failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const live = models.length > 0;
    if (live && apiKey) {
      const modelId = models.find((m) => m.id === "default")?.id ?? models[0].id;
      this.deps.prewarm?.({ apiKey, modelId });
    }
    this.catalog = { models: live ? models : FALLBACK_MODELS, live, at: Date.now() };
    return this.catalog.models;
  }
}

export { PROVIDER_ID };
