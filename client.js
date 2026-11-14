/**
 * cursor-to-dsh — browser half.
 *
 * Puts the API-key card in the Cursor row of Settings → Models. It registers into the
 * `settings.models.provider-card` seat, keyed by the row's settings namespace, and saves the
 * key through the Host credentials service under the reference the Host half resolves. A fresh
 * install therefore needs no credential-file edit: paste the key, save, and the row's credential
 * dot turns green.
 *
 * Hand-written plain JavaScript loaded by the Web shell's module loader (`client.js` is listed
 * in `package.json` `files`, `exports`, and `dsh.client`), so the package needs no Client build
 * step and only requires the shell's baseline `react` module. Keep this file self-contained:
 * relative `require` of a sibling artifact is not supported by the loader.
 */
window.__ModuleLoader__.load({
  id: 'cursor-to-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useState } = React

    /** Locale dictionary namespace owned by this package. */
    const NS = 'cursor-to-dsh'
    /** Models page seat: one provider card's adapter extension area. */
    const SLOT = 'settings.models.provider-card'
    /** Seat key: the settings namespace, which is this bundle's Loader row id. */
    const SETTINGS_NS = 'llm-cursor'
    /** Page global published by the Host half with the effective credential reference. */
    const BOOT_GLOBAL = '__DSH_CURSOR_TO_DSH__'
    /** The plugin's own default `apiKeyEnv`; used when the page predates the row. */
    const DEFAULT_KEY_REF = 'CURSOR_API_KEY'
    /** Where Cursor issues API keys. */
    const KEY_PAGE = 'https://cursor.com/dashboard'
    /**
     * A key travels in an HTTP header, so it must be printable ASCII with no surrounding
     * whitespace. Same rule as the Models page applies to its own provider keys.
     */
    const KEY_PATTERN = /^[\x21-\x7E]+$/
    /** Credential references are POSIX-style names; a published value has to be one to be used. */
    const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

    const zh = {
      apiKey: 'API Key',
      getKey: '获取密钥',
      saved: '已保存',
      save: '保存',
      saving: '保存中…',
      replace: '更换',
      cancel: '取消',
      clear: '清除',
      clearing: '清除中…',
      show: '显示密钥',
      hide: '隐藏密钥',
      placeholder: '粘贴 Cursor API Key',
      hint: '只保存在本机凭据 {ref}，不会写入配置文件。',
      errorEmpty: '请输入 API Key。',
      errorFormat: 'API Key 只能包含可见 ASCII 字符（不含空格）。',
      errorHost: '保存密钥失败。',
    }

    const en = {
      apiKey: 'API key',
      getKey: 'Get a key',
      saved: 'Saved',
      save: 'Save',
      saving: 'Saving…',
      replace: 'Replace',
      cancel: 'Cancel',
      clear: 'Clear',
      clearing: 'Clearing…',
      show: 'Show key',
      hide: 'Hide key',
      placeholder: 'Paste your Cursor API key',
      hint: 'Stored only in the local credential {ref}, never in a configuration file.',
      errorEmpty: 'Enter an API key.',
      errorFormat: 'An API key holds only printable ASCII characters (no spaces).',
      errorHost: 'Saving the key failed.',
    }

    /** One card block; styles are component-local so unmounting removes them. */
    const CSS = `
.ctd-key { display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 20px; }
.ctd-key-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; }
.ctd-key-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.ctd-key-link { font-size: 12px; color: var(--dsw-alias-label-secondary); text-decoration: none; }
.ctd-key-link:hover { color: var(--dsw-alias-brand-primary); }
.ctd-key-row { display: flex; align-items: center; gap: 6px; min-height: 32px; }
.ctd-key-state { display: inline-flex; flex: 1 1 auto; min-width: 0; align-items: center; gap: 6px; color: var(--dsw-alias-label-primary); }
.ctd-key-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.ctd-key-ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ctd-key-field { position: relative; flex: 1 1 auto; min-width: 0; }
.ctd-key-input {
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 34px 0 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  font: inherit; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  transition: border-color 0.12s;
}
.ctd-key-input::placeholder { color: var(--dsw-alias-label-secondary); }
.ctd-key-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.ctd-key-input:disabled { opacity: 0.6; }
.ctd-key-input-invalid, .ctd-key-input-invalid:focus { border-color: var(--dsw-alias-state-error-primary); }
.ctd-key-eye {
  position: absolute; top: 0; right: 0; bottom: 0; display: inline-flex; align-items: center;
  justify-content: center; width: 32px; padding: 0; border: none;
  background: none; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.ctd-key-eye:hover { color: var(--dsw-alias-label-primary); }
.ctd-key-btn {
  box-sizing: border-box; flex: none; height: 32px; padding: 0 12px; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; cursor: pointer; white-space: nowrap; transition: background 0.12s, color 0.12s, opacity 0.12s;
}
.ctd-key-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.ctd-key-btn:disabled { opacity: 0.4; cursor: default; }
.ctd-key-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); }
.ctd-key-primary:hover:not(:disabled) { color: var(--dsw-alias-bg-base); background: color-mix(in srgb, var(--dsw-alias-label-primary) 85%, var(--dsw-alias-bg-base)); }
.ctd-key-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.ctd-key-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.ctd-key-error { color: var(--dsw-alias-state-error-primary); }
`

    /** Eye / eye-off glyph for the reveal toggle. */
    function EyeIcon(props) {
      const contour = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', 'aria-hidden': true,
      }, h('path', { d: props.off ? `${contour}M2.5 2.5L13.5 13.5` : `${contour}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z` }))
    }

    /** One readable message for a thrown value, whichever realm it came from. */
    function messageOf(error) {
      if (error === null || error === undefined) return ''
      return typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    }

    /** Turn one `save`/`clear` answer into the copy the card shows. */
    function failureText(t, answer) {
      if (answer.code === 'empty') return t('errorEmpty')
      if (answer.code === 'format') return t('errorFormat')
      return answer.message || t('errorHost')
    }

    /**
     * The Cursor provider card. With a key configured it is one status line (replace / clear);
     * otherwise, or while replacing, it is one write-only key field with its save action.
     * @param props - owner props (the directory row and whether a key is configured) plus the
     * injected Host callbacks and copy.
     */
    function CursorKeyCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const keyRef = typeof props.keyRef === 'string' && props.keyRef ? props.keyRef : DEFAULT_KEY_REF
      const [draft, setDraft] = useState('')
      const [revealed, setRevealed] = useState(false)
      const [busy, setBusy] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [editing, setEditing] = useState(false)
      /** The card's last own action wins over the page's credential join until it catches up. */
      const [local, setLocal] = useState(undefined)
      const configured = local === undefined ? props.keyConfigured === true : local === 'saved'
      const value = draft.trim()
      const canSave = value.length > 0 && busy === undefined

      const close = useCallback(() => {
        setEditing(false)
        setDraft('')
        setRevealed(false)
        setError(undefined)
      }, [])

      const commit = useCallback(async () => {
        if (!canSave) return
        setBusy('save')
        setError(undefined)
        try {
          const answer = await props.save(value)
          if (answer.code !== undefined) {
            setError(failureText(t, answer))
            return
          }
          setLocal('saved')
          close()
        } catch (thrown) {
          setError(messageOf(thrown) || t('errorHost'))
        } finally {
          setBusy(undefined)
        }
      }, [canSave, value, props.save, t, close])

      const remove = useCallback(async () => {
        if (busy !== undefined) return
        setBusy('clear')
        setError(undefined)
        try {
          const answer = await props.clear()
          if (answer.code !== undefined) setError(failureText(t, answer))
          else setLocal('cleared')
        } catch (thrown) {
          setError(messageOf(thrown) || t('errorHost'))
        } finally {
          setBusy(undefined)
        }
      }, [busy, props.clear, t])

      const button = (className, label, onClick, disabled) => h('button', {
        className: `ctd-key-btn${className ? ` ${className}` : ''}`,
        type: 'button',
        disabled: disabled === true,
        onClick,
      }, label)

      const errorLine = error === undefined
        ? null
        : h('p', { className: 'ctd-key-note ctd-key-error', role: 'alert' }, error)

      if (configured && !editing) {
        return h('div', { className: 'ctd-key' },
          h('style', null, CSS),
          h('div', { className: 'ctd-key-head' },
            h('span', { className: 'ctd-key-label' }, t('apiKey'))),
          h('div', { className: 'ctd-key-row' },
            h('span', { className: 'ctd-key-state' },
              h('span', { className: 'ctd-key-dot', 'aria-hidden': true }),
              h('span', null, t('saved')),
              h('span', { className: 'ctd-key-ref', title: keyRef }, keyRef)),
            button(undefined, t('replace'), () => { setError(undefined); setEditing(true) }, busy !== undefined),
            button('ctd-key-danger', busy === 'clear' ? t('clearing') : t('clear'), () => { void remove() }, busy !== undefined)),
          errorLine)
      }

      return h('div', { className: 'ctd-key' },
        h('style', null, CSS),
        h('div', { className: 'ctd-key-head' },
          h('span', { className: 'ctd-key-label' }, t('apiKey')),
          h('a', { className: 'ctd-key-link', href: KEY_PAGE, target: '_blank', rel: 'noreferrer' }, `${t('getKey')} \u2197`)),
        h('div', { className: 'ctd-key-row' },
          h('div', { className: 'ctd-key-field' },
            h('input', {
              className: `ctd-key-input${error === undefined ? '' : ' ctd-key-input-invalid'}`,
              type: revealed ? 'text' : 'password',
              value: draft,
              placeholder: t('placeholder'),
              autoComplete: 'new-password',
              autoFocus: editing,
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              'aria-label': t('apiKey'),
              'aria-invalid': error !== undefined,
              disabled: busy !== undefined,
              onChange: (event) => { setDraft(event.target.value); setError(undefined) },
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commit()
                } else if (event.key === 'Escape' && editing) {
                  event.preventDefault()
                  close()
                }
              },
            }),
            h('button', {
              className: 'ctd-key-eye',
              type: 'button',
              tabIndex: -1,
              'aria-label': t(revealed ? 'hide' : 'show'),
              'aria-pressed': revealed,
              onClick: () => { setRevealed((current) => !current) },
            }, h(EyeIcon, { off: revealed }))),
          editing ? button(undefined, t('cancel'), close, busy !== undefined) : null,
          button('ctd-key-primary', busy === 'save' ? t('saving') : t('save'), () => { void commit() }, !canSave)),
        errorLine || h('p', { className: 'ctd-key-note' }, t('hint').replace('{ref}', keyRef)))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cursor-to-dsh: copy')

        /** The credential reference the Host half resolves; the page global wins over the default. */
        const keyRef = () => {
          const boot = globalThis[BOOT_GLOBAL]
          const named = boot && typeof boot.keyRef === 'string' ? boot.keyRef.trim() : ''
          return KEY_REF_PATTERN.test(named) ? named : DEFAULT_KEY_REF
        }

        /** One answer shape for both actions: `code` absent means the Host accepted it. */
        const refused = (error) => ({ code: 'host', message: messageOf(error) })

        const save = async (raw) => {
          const value = typeof raw === 'string' ? raw.trim() : ''
          if (!value) return { code: 'empty' }
          if (!KEY_PATTERN.test(value)) return { code: 'format' }
          try {
            const response = await ctx.remote.credentials.set(keyRef(), value)
            return response && response.ok ? {} : refused(response?.error?.message)
          } catch (error) {
            return refused(error)
          }
        }

        const clear = async () => {
          try {
            const response = await ctx.remote.credentials.unset(keyRef())
            return response && response.ok ? {} : refused(response?.error?.message)
          } catch (error) {
            return refused(error)
          }
        }

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          key: SETTINGS_NS,
          locale: NS,
          inject: () => ({ keyRef: keyRef(), save, clear }),
        }, CursorKeyCard))
      },
      /** Pure seams for the unit tests; the browser half itself only needs `apply`. */
      testing: { KEY_PATTERN, DEFAULT_KEY_REF, SETTINGS_NS, SLOT, BOOT_GLOBAL },
    }
  },
})
