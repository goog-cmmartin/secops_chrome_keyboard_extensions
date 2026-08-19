// monaco_bridge.js
// Runs in the MAIN world context to interface directly with window.monaco
(function() {
  const STORAGE_KEY = 'secops_ext_monaco_typeahead';

  /**
   * Returns current setting from localStorage.
   * Default is false (OFF / High Performance).
   */
  function isTypeaheadEnabled() {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  }

  /**
   * Applies Monaco editor options based on typeahead preference.
   */
  function applyToEditor(editor, enabled) {
    if (!editor || typeof editor.updateOptions !== 'function') return;
    editor.updateOptions({
      quickSuggestions: enabled ? { other: "on", comments: "on", strings: "on" } : false,
      suggestOnTriggerCharacters: enabled,
      wordBasedSuggestions: enabled,
      snippetSuggestions: enabled ? 'inline' : 'none'
    });
  }

  /**
   * Applies setting to all existing Monaco editor instances.
   */
  function applyToAllEditors(enabled) {
    if (window.monaco && window.monaco.editor && typeof window.monaco.editor.getEditors === 'function') {
      const editors = window.monaco.editor.getEditors();
      editors.forEach(ed => applyToEditor(ed, enabled));
    }
  }

  /**
   * Initializes Monaco hooks for current and future editor instances.
   */
  let hookAttached = false;
  function initMonacoHooks() {
    if (window.monaco && window.monaco.editor) {
      if (!hookAttached && typeof window.monaco.editor.onDidCreateEditor === 'function') {
        hookAttached = true;
        window.monaco.editor.onDidCreateEditor(ed => {
          applyToEditor(ed, isTypeaheadEnabled());
        });
      }
      applyToAllEditors(isTypeaheadEnabled());
    }
  }

  // Zero-polling event-driven trap for window.monaco
  if (window.monaco && window.monaco.editor) {
    initMonacoHooks();
  } else {
    let monacoInstance = window.monaco;
    try {
      Object.defineProperty(window, 'monaco', {
        configurable: true,
        enumerable: true,
        get() {
          return monacoInstance;
        },
        set(val) {
          monacoInstance = val;
          initMonacoHooks();
        }
      });
    } catch (e) {
      // Fallback: brief interval if window property is sealed
      const interval = setInterval(() => {
        if (window.monaco && window.monaco.editor) {
          initMonacoHooks();
          clearInterval(interval);
        }
      }, 250);
      setTimeout(() => clearInterval(interval), 15000);
    }
  }

  // Listen for toggle requests from extension content script
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SECOPS_EXT_SET_TYPEAHEAD') {
      const enabled = !!event.data.enabled;
      localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
      applyToAllEditors(enabled);
      window.postMessage({ type: 'SECOPS_EXT_TYPEAHEAD_CHANGED', enabled }, '*');
    } else if (event.data && event.data.type === 'SECOPS_EXT_GET_TYPEAHEAD') {
      window.postMessage({ type: 'SECOPS_EXT_TYPEAHEAD_CHANGED', enabled: isTypeaheadEnabled() }, '*');
    }
  });

  // Initial attempt
  initMonacoHooks();
})();
