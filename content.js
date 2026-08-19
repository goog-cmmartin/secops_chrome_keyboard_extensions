// content.js
let toast;
let toastTimeout;
let activeCommandElements = [];
let selectedCommandIndex = 0;
let headerButton = null;
let searchInputRaf = null;
const STORAGE_TYPEAHEAD_KEY = 'secops_ext_monaco_typeahead';
const STORAGE_TURBO_KEY = 'secops_ext_turbo_mode';

/**
 * Checks if the Chrome extension context is still active.
 * When the extension is reloaded/updated, old content scripts in existing tabs
 * lose context and must gracefully stop accessing chrome.runtime.* APIs.
 */
function isContextValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

function formatKey(code) {
  if (!code) return "";
  if (code === "Slash") return "?";
  return code.replace(/^Digit/, '').replace(/^Key/, '');
}


/**
 * Fast traversal of light DOM and open Shadow DOM boundaries to find an element.
 */
function queryDeep(selector, root = document) {
  try {
    const el = root.querySelector(selector);
    if (el) return el;
  } catch (e) {}

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) {
      const found = queryDeep(selector, node.shadowRoot);
      if (found) return found;
    }
    node = walker.nextNode();
  }
  return null;
}

/**
 * Fast traversal of light DOM and open Shadow DOM boundaries to find all matching elements.
 */
function queryDeepAll(selector, root = document) {
  let results = [];
  try {
    results = Array.from(root.querySelectorAll(selector));
  } catch (e) {}

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.shadowRoot) {
      results = results.concat(queryDeepAll(selector, node.shadowRoot));
    }
    node = walker.nextNode();
  }
  return results;
}

/**
 * Performs client-side Single Page Application (SPA) navigation using Angular's router
 * via native navigation anchor links. Avoids hard browser reloads.
 */
function navigateClientSide(targetPath, fallbackPath = null) {
  const cleanPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;

  const navLink = document.querySelector(
    `sc-navigation a[href="${cleanPath}"], sc-navigation a[href^="${cleanPath}"], a[href="${cleanPath}"]`
  );

  if (navLink) {
    navLink.click();
    return;
  }

  if (fallbackPath) {
    const cleanFallback = fallbackPath.startsWith('/') ? fallbackPath : '/' + fallbackPath;
    const fallbackLink = document.querySelector(
      `sc-navigation a[href="${cleanFallback}"], sc-navigation a[href^="${cleanFallback}"], a[href="${cleanFallback}"]`
    );
    if (fallbackLink) {
      fallbackLink.click();
      return;
    }
  }

  window.location.href = `${window.location.origin}${cleanPath}`;
}

/**
 * Turbo Performance Mode (CSS Containment & GPU Layer Compositing)
 * Defaults to true (ON / Active).
 */
function getTurboModePreference() {
  const val = localStorage.getItem(STORAGE_TURBO_KEY);
  return val === null ? true : val === 'true';
}

function applyTurboMode(enabled) {
  let styleEl = document.getElementById('secops-ext-turbo-styles');
  if (enabled) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'secops-ext-turbo-styles';
      styleEl.textContent = `
        /* CSS Layout & Style Containment: Stops layout cascades to the 112,000 DOM nodes */
        sc-widget-container,
        mc-widget-container,
        swc-collapsible-search-query-editor,
        sc-timeline-chart,
        #fields-aggregations,
        .collapsible-query-editor-container,
        cases-dynamic-layout,
        sc-navigation-header {
          contain: layout style !important;
        }

        /* Offscreen and collapsed component rendering optimization */
        sc-timeline-chart:not(.active),
        #event-count-chart:not(.active),
        .collapsed-search-query-editor-header-left {
          contain: content !important;
        }

        /* Table Row & Cell GPU Layer Hardware Acceleration */
        sc-formatted-cell,
        .cell,
        smp-highlight,
        [role="row"] {
          transform: translateZ(0);
        }

        /* Prune expensive CPU micro-transitions on heavy tabular elements */
        .cell,
        sc-formatted-cell,
        smp-highlight,
        [role="gridcell"] {
          transition: none !important;
        }
      `;
      document.head.appendChild(styleEl);
    }
  } else {
    if (styleEl) {
      styleEl.remove();
    }
  }
}

function setTurboModePreference(enabled) {
  localStorage.setItem(STORAGE_TURBO_KEY, enabled ? 'true' : 'false');
  applyTurboMode(enabled);
  updateTurboModeUI(enabled);
}

function toggleTurboMode() {
  const currentState = getTurboModePreference();
  const newState = !currentState;
  setTurboModePreference(newState);
  const statusMsg = newState ? "Turbo Mode: Enabled (Max Performance)" : "Turbo Mode: Disabled";
  showToast(statusMsg);
}

function updateTurboModeUI(enabled) {
  const pill = document.getElementById("turboStatusPill");
  const pillText = document.getElementById("turboPillText");
  if (pill && pillText) {
    pill.className = enabled ? "status-pill status-pill--on" : "status-pill status-pill--off";
    pillText.textContent = enabled ? "ON" : "OFF";
  }
}

/**
 * Monaco Typeahead preference management (Default: OFF / High Performance)
 */
function getMonacoTypeaheadPreference() {
  return localStorage.getItem(STORAGE_TYPEAHEAD_KEY) === 'true';
}

function setMonacoTypeaheadPreference(enabled) {
  localStorage.setItem(STORAGE_TYPEAHEAD_KEY, enabled ? 'true' : 'false');
  window.postMessage({ type: 'SECOPS_EXT_SET_TYPEAHEAD', enabled }, '*');
  updateMonacoTypeaheadUI(enabled);
}

function toggleMonacoTypeahead() {
  const currentState = getMonacoTypeaheadPreference();
  const newState = !currentState;
  setMonacoTypeaheadPreference(newState);
  const statusMsg = newState ? "Monaco Typeahead: Enabled" : "Monaco Typeahead: Disabled (High Performance)";
  showToast(statusMsg);
}

function updateMonacoTypeaheadUI(enabled) {
  const pill = document.getElementById("monacoStatusPill");
  const pillText = document.getElementById("monacoPillText");
  if (pill && pillText) {
    pill.className = enabled ? "status-pill status-pill--on" : "status-pill status-pill--off";
    pillText.textContent = enabled ? "ON" : "OFF";
  }
}

// Listen for updates from monaco_bridge
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SECOPS_EXT_TYPEAHEAD_CHANGED') {
    updateMonacoTypeaheadUI(event.data.enabled);
  }
});

/**
 * Computes a quick 32-bit hash of a string to track rendering state.
 */
function simpleHash(str) {
  if (!str) return "0";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

/**
 * Checks if HTML contains unformatted Markdown signatures.
 */
function hasUnrenderedMarkdown(html) {
  if (!html) return false;
  return html.includes('**') ||
         html.includes('`') ||
         html.includes('#') ||
         html.includes('•') ||
         html.includes('](') ||
         html.includes('| -') ||
         html.includes('|:-') ||
         html.includes('|:--') ||
         html.includes('---') ||
         /(?:^|\n)[ \t]*[\-\*][ \t]+/.test(html);
}

/**
 * Renders & repairs Markdown in Gemini Summary widgets, SOAR Case Wall comments, and analyst notes
 * while strictly preserving interactive entity links, user avatars, and "View More" triggers.
 */
function renderMarkdownInPage(root = document) {
  const targets = root.querySelectorAll(
    '.search-markers, cases-dynamic-command-line, [data-automation="gemini-summary"], .gemini-summary-content, ' +
    'comment-activity .evidence-activity-comment, .evidence-activity-comment p, wall-evidence-activity p, comment-activity p'
  );

  let fixedCount = 0;

  targets.forEach(container => {
    // If it's a wrapper container and contains a child <p>, let the <p> be processed directly
    if (container.tagName !== 'P' && container.querySelector('p')) {
      return;
    }

    const rawHtml = container.innerHTML;
    const contentHash = simpleHash(rawHtml);

    // If this exact text was already parsed and formatted, skip
    if (container.dataset.secopsMdHash === contentHash) {
      return;
    }

    if (!hasUnrenderedMarkdown(rawHtml)) {
      return;
    }

    const preserved = [];
    let text = rawHtml.replace(/<a\b[\s\S]*?<\/a>|<span class="url[^"]*"[\s\S]*?<\/span>/gi, (match) => {
      const idx = preserved.length;
      preserved.push(match);
      return `⟦PRESERVED_${idx}⟧`;
    });

    text = text.replace(/<!---->/g, '');
    text = text.replace(/<\/?span(?:\s+class="(?:ng-star-inserted)?")?>/gi, '');
    text = text.replace(/\r\n/g, '\n');

    // 1. Code blocks (fenced ```...```)
    text = text.replace(/```([a-z0-9_-]*)\n?([\s\S]*?)```/gi, (match, lang, code) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre class="secops-code-block"><code>${escaped.trim()}</code></pre>`;
    });

    // 2. Markdown Tables
    text = text.replace(/((?:^|\n)\|[^\n]+\|\n\|[-:\s|]+\|\n(?:\|[^\n]+\|\n?)+)/g, (match) => {
      const lines = match.trim().split('\n');
      if (lines.length < 2) return match;
      
      const parseRow = (row, tag = 'td') => {
        const cells = row.split('|').slice(1, -1);
        return '<tr>' + cells.map(c => `<${tag} class="secops-table-cell">${c.trim()}</${tag}>`).join('') + '</tr>';
      };

      const headerHtml = '<thead>' + parseRow(lines[0], 'th') + '</thead>';
      const bodyRows = lines.slice(2).map(r => parseRow(r, 'td')).join('');
      const bodyHtml = '<tbody>' + bodyRows + '</tbody>';

      return `\n<div class="secops-table-wrapper"><table class="secops-md-table">${headerHtml}${bodyHtml}</table></div>\n`;
    });

    // 3. Horizontal Rules (--- or ***)
    text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="secops-md-hr">');

    // 4. Headings (Using styled divs to avoid splitting <p> containers in browser parser)
    text = text.replace(/^###\s+(.*?)(?:\s*###)?$/gm, '<div class="secops-md-h3">$1</div>');
    text = text.replace(/^##\s+(.*?)(?:\s*##)?$/gm, '<div class="secops-md-h2">$1</div>');
    text = text.replace(/^#\s+(.*?)(?:\s*#)?$/gm, '<div class="secops-md-h1">$1</div>');

    // 5. Inline code
    text = text.replace(/`([^`]+)`/g, '<code class="secops-inline-code">$1</code>');

    // 6. Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 7. Bullet lists (•, -, *, including indented '*   ')
    text = text.replace(/^[ \t]*[•\-\*][ \t]+(.*?)$/gm, '<li class="secops-md-li">$1</li>');
    text = text.replace(/((?:<li class="secops-md-li">[\s\S]*?<\/li>\s*)+)/g, '<ul class="secops-md-ul">$1</ul>');

    // 8. Italics
    text = text.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');

    // 9. Markdown Links [text](url)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="secops-md-link">$1</a>');

    // 10. Raw URLs
    text = text.replace(/(^|[\s>(])(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" class="secops-md-link">$2</a>');

    // 11. Paragraph spacers (convert double newlines outside tags to consistent vertical rhythm)
    text = text.replace(/\n\n+/g, '<div class="secops-md-spacer"></div>');

    // Restore preserved anchors & entity chips
    preserved.forEach((item, idx) => {
      text = text.replaceAll(`⟦PRESERVED_${idx}⟧`, item);
    });

    container.innerHTML = text;
    container.classList.add('secops-md-rendered');
    container.dataset.secopsMdHash = simpleHash(container.innerHTML);
    container.dataset.markdownFixed = "true";
    fixedCount++;
  });

  return fixedCount;
}


// Global click delegation for expanding/collapsing Case Wall items & comments
document.addEventListener('click', (event) => {
  const target = event.target;
  if (target && (target.closest?.('.show-more__anchor') || target.closest?.('comment-activity') || target.closest?.('wall-evidence-activity'))) {
    [0, 50, 150, 300, 500].forEach(delay => {
      setTimeout(() => scheduleMutationPass(), delay);
    });
  }
}, { passive: true });



/**
 * Central Command Registry for SecOps Navigation and Actions
 */
const commandCatalog = [
  // Navigation Commands
  {
    id: "nav-cases",
    name: "SOAR Cases",
    description: "Open Incident Cases and Investigations overview",
    category: "Navigation",
    route: "/cases",
    shortcut: "Digit1",
    keywords: ["cases", "soar", "incident", "alerts", "triage"],
    action: () => navigateClientSide('/cases')
  },
  {
    id: "nav-workdesk",
    name: "SOAR Workdesk",
    description: "Open Analyst Personal Workdesk & Queues",
    category: "Navigation",
    route: "/your-workdesk",
    shortcut: "Digit2",
    keywords: ["workdesk", "tasks", "my cases", "assigned", "queue"],
    action: () => navigateClientSide('/your-workdesk')
  },
  {
    id: "nav-search",
    name: "SIEM UDM Search",
    description: "Search raw logs and unified data model (UDM) events",
    category: "Navigation",
    route: "/search",
    shortcut: "Digit3",
    keywords: ["search", "udm", "siem", "query", "logs", "events"],
    action: () => navigateClientSide('/search')
  },
  {
    id: "nav-sp-search",
    name: "SOAR Search",
    description: "Search across SOAR alerts, entities, and playbooks",
    category: "Navigation",
    route: "/sp-search",
    shortcut: "Digit4",
    keywords: ["soar search", "sp search", "entity search", "cases search"],
    action: () => navigateClientSide('/sp-search')
  },
  {
    id: "nav-data-tables",
    name: "SIEM Data Tables",
    description: "View and manage reference lists and contextual data tables",
    category: "Navigation",
    route: "/data-tables",
    shortcut: "Digit5",
    keywords: ["data tables", "tables", "lookup", "reference lists", "iocs"],
    action: () => navigateClientSide('/data-tables')
  },
  {
    id: "nav-rules",
    name: "SIEM Rules & Detections",
    description: "Open YARA-L Rules editor and detection engine",
    category: "Navigation",
    route: "/rules",
    shortcut: "Digit6",
    keywords: ["rules", "yara-l", "detections", "rule editor", "alerts"],
    action: () => navigateClientSide('/rules', '/rulesEditor')
  },
  {
    id: "nav-dashboards",
    name: "SIEM Native Dashboards",
    description: "Open operational metrics and executive security dashboards",
    category: "Navigation",
    route: "/dashboards-v2",
    shortcut: "Digit7",
    keywords: ["dashboards", "reports", "charts", "metrics", "analytics"],
    action: () => navigateClientSide('/dashboards-v2')
  },
  {
    id: "nav-content-hub",
    name: "SecOps Marketplace & Content Hub",
    description: "Explore integrations, parsers, playbooks, and rule packs",
    category: "Navigation",
    route: "/content-hub",
    shortcut: "Digit8",
    keywords: ["marketplace", "content hub", "integrations", "packs", "store"],
    action: () => navigateClientSide('/content-hub', '/marketplace')
  },
  {
    id: "nav-settings",
    name: "SIEM Settings",
    description: "Manage SIEM feeds, parsers, and data ingestion",
    category: "Navigation",
    route: "/settings",
    shortcut: "Digit9",
    keywords: ["settings", "siem settings", "feeds", "parsers", "ingestion"],
    action: () => navigateClientSide('/settings')
  },
  {
    id: "nav-sp-settings",
    name: "SOAR Settings",
    description: "Configure SOAR environments, connectors, and users",
    category: "Navigation",
    route: "/sp-settings",
    shortcut: "Digit0",
    keywords: ["soar settings", "sp settings", "environments", "playbook settings"],
    action: () => navigateClientSide('/sp-settings')
  },
  {
    id: "nav-playbooks",
    name: "SOAR Playbooks",
    description: "Build and manage automated response workflows",
    category: "Navigation",
    route: "/playbooks",
    shortcut: null,
    keywords: ["playbooks", "automation", "workflows", "blocks", "actions"],
    action: () => navigateClientSide('/playbooks')
  },
  {
    id: "nav-integrations",
    name: "SOAR Integrations",
    description: "Manage third-party product connectors and instances",
    category: "Navigation",
    route: "/integrations",
    shortcut: null,
    keywords: ["integrations", "instances", "api", "connectors"],
    action: () => navigateClientSide('/integrations')
  },
  {
    id: "nav-feeds",
    name: "SIEM Data Feeds",
    description: "Manage log ingestion feeds and data sources",
    category: "Navigation",
    route: "/feeds",
    shortcut: null,
    keywords: ["feeds", "data feeds", "log sources", "collector"],
    action: () => navigateClientSide('/feeds', '/settings')
  },
  {
    id: "nav-entity-explorer",
    name: "Entity Explorer",
    description: "Investigate hosts, users, IP addresses, and domains",
    category: "Navigation",
    route: "/entity-explorer",
    shortcut: null,
    keywords: ["entity", "user", "hostname", "ip", "asset", "explorer"],
    action: () => navigateClientSide('/entity-explorer')
  },
  {
    id: "nav-labs",
    name: "SecOps Labs",
    description: "Explore experimental AI and platform features",
    category: "Navigation",
    route: "/labs",
    shortcut: null,
    keywords: ["labs", "experimental", "google labs", "preview"],
    action: () => navigateClientSide('/labs')
  },

  // Performance & Tuning Actions
  {
    id: "act-toggle-turbo",
    name: "Toggle Turbo Performance Mode",
    description: "Toggle CSS containment and GPU hardware acceleration (Default: ON)",
    category: "Performance",
    shortcut: "KeyP",
    keywords: ["turbo", "performance", "containment", "speed", "lag", "fast", "gpu", "render", "stutter"],
    action: () => toggleTurboMode()
  },
  {
    id: "act-toggle-typeahead",
    name: "Toggle Monaco Schema Typeahead (Autocomplete)",
    description: "Toggle popup autocomplete in UDM Search and YARA-L Rule Editor",
    category: "Performance",
    shortcut: "KeyT",
    keywords: ["typeahead", "autocomplete", "monaco", "performance", "slow", "lag", "suggestions", "speed", "fast"],
    action: () => toggleMonacoTypeahead()
  },

  // Case & AI Actions
  {
    id: "act-gemini-panel",
    name: "Toggle Gemini AI Side Panel",
    description: "Open or close the SecOps Gemini assistant sidebar",
    category: "Actions",
    shortcut: "KeyG",
    keywords: ["gemini", "ai", "side panel", "chat", "assistant"],
    action: () => {
      const btn = document.querySelector('sc-navigation-header-actions button[aria-label*="AI" i]') ||
                  document.querySelector('sc-navigation-header-actions button[aria-label*="Gemini" i]') ||
                  document.querySelector('body > app-root > siem-main-layout > sc-navigation > sc-navigation-header > section > sc-navigation-header-actions > div > button');
      btn?.click();
    }
  },
  {
    id: "act-repair-markdown",
    name: "Format Markdown in Summaries & Case Wall",
    description: "Render clean Markdown headers, lists, code blocks & bold text in Case Wall & Gemini summaries",
    category: "Cases",
    shortcut: "KeyR",
    keywords: ["repair", "markdown", "gemini summary", "case wall", "comments", "format", "render", "code block"],
    action: () => {
      const count = renderMarkdownInPage(document);
      showToast(count > 0 ? `Formatted ${count} Markdown Block(s)` : "Markdown Up to Date");
    }
  },
  {
    id: "act-toggle-comments",
    name: "Toggle Case Comments",
    description: "Open or close case comments and analyst notes modal",
    category: "Cases",
    shortcut: "KeyN",
    keywords: ["comments", "notes", "case comments", "chat"],
    action: () => {
      document.querySelector("#siem-main-content cases-page cases-dynamic-layout smp-layout smp-layout-content cases-dynamic-command-line cases-command-line div.right button:nth-child(2)")
        ?.click();
    }
  },

  // UDM Search Actions
  {
    id: "act-udm-lookup",
    name: "UDM Field Lookup",
    description: "Open the interactive UDM schema and field reference popup",
    category: "UDM Search",
    shortcut: "KeyU",
    keywords: ["udm lookup", "fields", "schema", "syntax", "reference"],
    action: () => {
      queryDeep('button.udm-lookup-button')?.click();
    }
  },
  // Tab Management Actions
  {
    id: "act-switch-prev-tab",
    name: "Switch to Previous SecOps Tab",
    description: "Quick-toggle back to your last active SecOps tab (SecOps Alt+Tab)",
    category: "Tabs",
    shortcut: "KeyB",
    keywords: ["tab", "switch", "previous", "toggle", "back", "recent", "tab switch"],
    action: () => {
      if (!isContextValid()) return;
      chrome.runtime.sendMessage({ action: "SWITCH_TO_PREVIOUS_TAB" }, (res) => {
        if (res && res.success) {
          showToast(`Switched to: ${res.tabTitle || 'SecOps Tab'}`);
        } else {
          showToast(res?.reason || "No other open SecOps tabs found");
        }
      });
    }
  },
  {
    id: "act-collapse-editor",
    name: "Toggle Query Editor",
    description: "Collapse or expand the search query editor panel",
    category: "UDM Search",
    shortcut: "KeyC",
    keywords: ["collapse query", "expand query", "toggle editor", "editor size"],
    action: () => {
      const btn = queryDeep('button[test-element="search-query-editor-collapse-button"], button.collapse-button, button[aria-label*="Toggle search query editor" i]');
      btn?.click();
    }
  },
  {
    id: "act-toggle-filter",
    name: "Add / Toggle Search Filter",
    description: "Open filter builder to filter UDM event fields",
    category: "UDM Search",
    shortcut: "KeyF",
    keywords: ["filter", "add filter", "filter bar", "criteria"],
    action: () => {
      const trigger = queryDeep('#new-filter-trigger');
      const btn = trigger?.shadowRoot?.querySelector('button') || trigger;
      btn?.click();
    }
  },
  {
    id: "act-columns-manager",
    name: "Manage Table Columns",
    description: "Select, reorder, and customize visible columns in results",
    category: "UDM Search",
    shortcut: "KeyL",
    keywords: ["columns", "column selector", "fields", "table layout"],
    action: () => {
      queryDeep('button.column-manager-button, sc-column-manager-trigger-button button')?.click();
    }
  },
  {
    id: "act-wrap-text",
    name: "Toggle Word Wrap",
    description: "Wrap or unwrap long text values in search results table",
    category: "UDM Search",
    shortcut: "KeyW",
    keywords: ["wrap text", "unwrap text", "table wrap", "formatting"],
    action: () => {
      const btn = queryDeep('button.word-wrap-icon-new, button[icon="text-wrap"], button.word-wrap-icon');
      btn?.click();
    }
  },
  {
    id: "act-aggregations",
    name: "Toggle Aggregations Panel",
    description: "Open or collapse grouped fields and aggregation sidebar",
    category: "UDM Search",
    shortcut: "KeyA",
    keywords: ["aggregations", "stats", "count", "grouped fields", "summary"],
    action: () => {
      const container = queryDeepAll('mc-widget-container').find(c => c.innerText?.includes('AGGREGATIONS') || c.id === 'fields-aggregations');
      const toggleBtn = container?.shadowRoot?.querySelector('#toggle') || queryDeep('#fields-aggregations #toggle');
      toggleBtn?.click();
    }
  },
  {
    id: "act-heatmap-chart",
    name: "Toggle Activity & Trend Chart",
    description: "Show or hide timeline chart, prevalence, and event activity",
    category: "UDM Search",
    shortcut: "KeyM",
    keywords: ["heatmap", "trend", "activity", "prevalence", "timeline", "chart"],
    action: () => {
      const chartContainer = queryDeep('#event-count-chart') || queryDeep('sc-timeline-chart#detection-chart');
      const toggleBtn = chartContainer?.shadowRoot?.querySelector('#toggle') || chartContainer?.querySelector('button.collapsing-icon') || queryDeep('#event-count-chart #toggle');
      toggleBtn?.click();
    }
  },
  {
    id: "act-fields-manager",
    name: "Toggle Search & Event Fields",
    description: "Open search manager and field selection panel",
    category: "UDM Search",
    shortcut: "KeyE",
    keywords: ["fields manager", "search manager", "event fields", "properties"],
    action: () => {
      queryDeep('button.search-manager-button, sc-udm-fields-widget div.udm-fields-selection button, mc-search[aria-label="Search fields or values"] input')?.click();
    }
  }
];

// Helper to execute a command and close launcher
function executeCommand(cmd, inNewTab = false) {
  closeModal();
  if (inNewTab && cmd.route) {
    showToast(`Opened in New Tab: ${cmd.name}`);
    window.open(window.location.origin + cmd.route, '_blank');
    return;
  }
  showToast(`Running: ${cmd.name}`);
  try {
    cmd.action();
  } catch (err) {
    console.warn(`Command failed for ${cmd.name}:`, err);
  }
}

let insertModalPromise = null;

function insertModal() {
  if (!isContextValid()) return Promise.resolve();
  if (document.getElementById('shortcutModal')) return Promise.resolve();
  if (insertModalPromise) return insertModalPromise;

  insertModalPromise = (async () => {
    try {
      if (!document.body) {
        await new Promise(resolve => {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', resolve, { once: true });
          } else {
            resolve();
          }
        });
      }
      if (!document.body || document.getElementById('shortcutModal')) return;

      const [htmlResponse, cssResponse] = await Promise.all([
        fetch(chrome.runtime.getURL('modal.html')),
        fetch(chrome.runtime.getURL('styles.css'))
      ]);

      const html = await htmlResponse.text();
      const css = await cssResponse.text();

      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      document.body.insertAdjacentHTML('beforeend', html);

      const iconUrl = isContextValid() ? chrome.runtime.getURL('icon48.png') : '';
      const modalIcon = document.getElementById('modalIcon');
      if (modalIcon && iconUrl) modalIcon.src = iconUrl;

      const versionElement = document.getElementById("modalVersion");
      if (versionElement) {
        try {
          const manifest = chrome.runtime.getManifest();
          versionElement.innerHTML = `<b>Version</b>: ${manifest.version}`;
        } catch (e) {
          versionElement.innerHTML = `<b>Version</b>: 0.23.0`;
        }
      }

      toast = document.createElement("div");
      toast.id = "toast";
      document.body.appendChild(toast);

      document.getElementById("shortcutOverlay")?.addEventListener("click", closeModal);
      document.getElementById("closeModalButton")?.addEventListener("click", closeModal);

      // Wire up footer status pills
      document.getElementById("turboStatusPill")?.addEventListener("click", toggleTurboMode);
      document.getElementById("monacoStatusPill")?.addEventListener("click", toggleMonacoTypeahead);

      const searchInput = document.getElementById("shortcutSearchInput");
      
      // Search input typing & keyboard navigation with RAF debouncing
      searchInput?.addEventListener("input", function () {
        if (searchInputRaf) cancelAnimationFrame(searchInputRaf);
        const val = this.value;
        searchInputRaf = requestAnimationFrame(() => {
          populateCommandPalette(val);
        });
      });

      searchInput?.addEventListener("keydown", function (e) {
        // Navigation: ArrowDown, ArrowUp, Ctrl+N, Ctrl+P, Ctrl+J, Ctrl+K
        const isDown = e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"));
        const isUp = e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"));

        if (isDown) {
          e.preventDefault();
          if (activeCommandElements.length === 0) return;
          selectedCommandIndex = (selectedCommandIndex + 1) % activeCommandElements.length;
          updateSelectionHighlight();
          return;
        }
        
        if (isUp) {
          e.preventDefault();
          if (activeCommandElements.length === 0) return;
          selectedCommandIndex = (selectedCommandIndex - 1 + activeCommandElements.length) % activeCommandElements.length;
          updateSelectionHighlight();
          return;
        }

        if (e.key === "Enter") {
          e.preventDefault();
          if (activeCommandElements.length > 0 && activeCommandElements[selectedCommandIndex]) {
            const cmd = activeCommandElements[selectedCommandIndex].commandData;
            const inNewTab = e.shiftKey || e.ctrlKey || e.metaKey;
            executeCommand(cmd, inNewTab);
          }
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          closeModal();
          return;
        }

        // Quick Alt+1..9 or Ctrl+1..9 navigation directly from within palette
        if ((e.altKey || e.ctrlKey) && !e.shiftKey && e.code.startsWith("Digit") && e.code !== "Digit0") {
          const numCmd = commandCatalog.find(c => c.shortcut === e.code);
          if (numCmd) {
            e.preventDefault();
            executeCommand(numCmd, e.shiftKey);
            return;
          }
        }
      });

      // Initialize UI status pills
      updateTurboModeUI(getTurboModePreference());
      updateMonacoTypeaheadUI(getMonacoTypeaheadPreference());

    } catch (error) {
      console.error("Error inserting SecOps Command Palette modal:", error);
    } finally {
      insertModalPromise = null;
    }
  })();

  return insertModalPromise;
}

let cachedSecOpsTabs = [];

function fetchSecOpsTabs(callback) {
  if (!isContextValid()) return;
  try {
    chrome.runtime.sendMessage({ action: "GET_SECOPS_TABS" }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      cachedSecOpsTabs = response.tabs || [];
      if (callback) callback(cachedSecOpsTabs);
    });
  } catch (e) {
    // Context may be disconnected
  }
}

async function openModal() {
  let modal = document.getElementById("shortcutModal");
  let overlay = document.getElementById("shortcutOverlay");
  let searchInput = document.getElementById("shortcutSearchInput");

  if (!modal || !overlay) {
    await insertModal();
    modal = document.getElementById("shortcutModal");
    overlay = document.getElementById("shortcutOverlay");
    searchInput = document.getElementById("shortcutSearchInput");
  }

  if (!modal || !overlay) return;

  if (searchInput) {
    searchInput.value = "";
  }
  updateTurboModeUI(getTurboModePreference());
  updateMonacoTypeaheadUI(getMonacoTypeaheadPreference());
  populateCommandPalette("");
  modal.style.display = "block";
  overlay.style.display = "block";

  if (searchInput) {
    requestAnimationFrame(() => searchInput.focus());
  }

  fetchSecOpsTabs(() => {
    if (modal.style.display === "block") {
      populateCommandPalette(searchInput ? searchInput.value : "");
    }
  });
}

function closeModal() {
  const modal = document.getElementById("shortcutModal");
  const overlay = document.getElementById("shortcutOverlay");
  if (modal) modal.style.display = "none";
  if (overlay) overlay.style.display = "none";
}

function showToast(message) {
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
  }, 1600);
}

function updateSelectionHighlight() {
  activeCommandElements.forEach((el, idx) => {
    if (idx === selectedCommandIndex) {
      el.classList.add("is-selected");
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      el.classList.remove("is-selected");
    }
  });
}

function populateCommandPalette(searchTerm = "") {
  const listContainer = document.getElementById("shortcutList");
  if (!listContainer) return;

  listContainer.innerHTML = "";
  activeCommandElements = [];
  selectedCommandIndex = 0;

  const rawQuery = searchTerm.toLowerCase().trim();
  
  // Detect prefix scope
  let scope = 'all'; // 'all' | 'tabs' | 'nav' | 'actions' | 'cases'
  let cleanQuery = rawQuery;

  if (rawQuery.startsWith('@') || rawQuery.startsWith('tab:') || rawQuery.startsWith('t:')) {
    scope = 'tabs';
    cleanQuery = rawQuery.replace(/^(?:@|tab:|t:)\s*/, '');
  } else if (rawQuery.startsWith('/') || rawQuery.startsWith('nav:') || rawQuery.startsWith('p:')) {
    scope = 'nav';
    cleanQuery = rawQuery.replace(/^(?:\/|nav:|p:)\s*/, '');
  } else if (rawQuery.startsWith('>') || rawQuery.startsWith('act:') || rawQuery.startsWith('a:')) {
    scope = 'actions';
    cleanQuery = rawQuery.replace(/^(?:>|act:|a:)\s*/, '');
  } else if (rawQuery.startsWith('#') || rawQuery.startsWith('case:')) {
    scope = 'cases';
    cleanQuery = rawQuery.replace(/^(?:#|case:)\s*/, '');
  }

  // Dynamic commands representing all currently open SecOps tabs
  const dynamicTabCommands = cachedSecOpsTabs.map(t => ({
    id: `open-tab-${t.id}`,
    name: t.title || 'SecOps Tab',
    description: `${t.section} • ${t.url}`,
    category: "Open SecOps Tabs",
    isTab: true,
    isCurrentTab: t.isCurrentTab,
    tabData: t,
    badgeText: t.isCurrentTab ? "Current Tab" : "Switch ↵",
    keywords: ["tab", "switch", "tabs", t.title, t.section, t.url, "open tab"],
    action: () => {
      if (!t.isCurrentTab && isContextValid()) {
        chrome.runtime.sendMessage({ action: "SWITCH_TO_TAB", tabId: t.id });
      }
    }
  }));

  // Filter command pool by scope
  let pool = [];
  if (scope === 'tabs') {
    pool = dynamicTabCommands;
  } else if (scope === 'nav') {
    pool = commandCatalog.filter(c => c.category === 'Navigation');
  } else if (scope === 'actions') {
    pool = commandCatalog.filter(c => c.category !== 'Navigation');
  } else if (scope === 'cases') {
    pool = [
      ...dynamicTabCommands.filter(t => t.name.toLowerCase().includes('case') || t.description.toLowerCase().includes('case')),
      ...commandCatalog.filter(c => c.category === 'Cases' || c.id === 'nav-cases' || c.name.toLowerCase().includes('case') || c.keywords?.some(k => k.toLowerCase().includes('case')))
    ];
  } else {
    // Default 'all'
    pool = [...dynamicTabCommands, ...commandCatalog];
  }

  // Calculate search relevance score for each item
  function computeScore(cmd) {
    if (!cleanQuery) return 1;
    const name = cmd.name.toLowerCase();
    const desc = cmd.description.toLowerCase();
    const keywords = cmd.keywords || [];

    let score = 0;

    // Exact destination name match (e.g. user typed "cases" -> SOAR Cases gets top score)
    if (name === cleanQuery) score += 100;
    else if (name.startsWith(cleanQuery)) score += 60;
    else if (name.includes(cleanQuery)) score += 40;

    // Keyword exact / prefix match
    if (keywords.some(k => k.toLowerCase() === cleanQuery)) score += 50;
    else if (keywords.some(k => k.toLowerCase().startsWith(cleanQuery))) score += 30;
    else if (keywords.some(k => k.toLowerCase().includes(cleanQuery))) score += 15;

    // Description match
    if (desc.includes(cleanQuery)) score += 10;

    // Shortcut match (e.g. user types "alt+shift+1" or "1")
    if (cmd.shortcut) {
      const formatted = `alt+shift+${formatKey(cmd.shortcut)}`.toLowerCase();
      if (formatted.includes(cleanQuery) || formatKey(cmd.shortcut).toLowerCase() === cleanQuery) {
        score += 35;
      }
    }

    // Weighting preference: Navigation destination pages slightly prioritized when searching generic terms like "cases"
    if (cmd.category === 'Navigation') score += 5;
    if (cmd.isTab && !cmd.isCurrentTab) score += 3;

    return score;
  }

  const scored = pool
    .map(cmd => ({ cmd, score: computeScore(cmd) }))
    .filter(item => item.score > 0);

  // Default category order when no query is typed
  const categoryOrder = {
    "Open SecOps Tabs": 1,
    "Navigation": 2,
    "Cases": 3,
    "Tabs": 4,
    "UDM Search": 5,
    "Actions": 6,
    "Performance": 7
  };

  if (!cleanQuery) {
    scored.sort((a, b) => {
      const orderA = categoryOrder[a.cmd.category] || 99;
      const orderB = categoryOrder[b.cmd.category] || 99;
      return orderA - orderB;
    });
  } else {
    scored.sort((a, b) => b.score - a.score);
  }

  const filtered = scored.map(item => item.cmd);

  if (filtered.length === 0) {
    const emptyNotice = document.createElement('div');
    emptyNotice.style.textAlign = 'center';
    emptyNotice.style.padding = '32px';
    emptyNotice.style.color = 'var(--secops-ext-footer-text, #5c6370)';
    emptyNotice.textContent = `No items found matching "${searchTerm}". Use '@' for tabs, '/' for pages, or '>' for actions.`;
    listContainer.appendChild(emptyNotice);
    return;
  }

  const grouped = {};
  filtered.forEach(cmd => {
    if (!grouped[cmd.category]) grouped[cmd.category] = [];
    grouped[cmd.category].push(cmd);
  });

  const fragment = document.createDocumentFragment();
  const container = document.createElement('div');
  container.id = 'shortcutListContainer';

  const col1 = document.createElement('div');
  col1.className = 'shortcut-column';
  const col1Ul = document.createElement('ul');
  col1.appendChild(col1Ul);

  const col2 = document.createElement('div');
  col2.className = 'shortcut-column';
  const col2Ul = document.createElement('ul');
  col2.appendChild(col2Ul);

  let currentColUl = col1Ul;
  const categories = Object.keys(grouped);

  categories.forEach(category => {
    const categoryHeading = document.createElement("h3");
    categoryHeading.textContent = category;

    const col1Count = col1.querySelectorAll('.command-item, h3').length;
    const col2Count = col2.querySelectorAll('.command-item, h3').length;

    currentColUl = (col1Count <= col2Count) ? col1Ul : col2Ul;
    currentColUl.appendChild(categoryHeading);

    grouped[category].forEach(cmd => {
      const item = document.createElement("li");
      item.className = "command-item";
      item.commandData = cmd;

      const mainDiv = document.createElement("div");
      mainDiv.className = "command-item-main";

      const nameSpan = document.createElement("span");
      nameSpan.className = "command-item-name";
      nameSpan.textContent = cmd.name;

      const descSpan = document.createElement("span");
      descSpan.className = "command-item-desc";
      descSpan.textContent = cmd.description;

      mainDiv.appendChild(nameSpan);
      mainDiv.appendChild(descSpan);

      const metaDiv = document.createElement("div");
      metaDiv.className = "command-item-meta";

      if (cmd.isTab) {
        const badge = document.createElement("span");
        badge.className = cmd.isCurrentTab ? "tab-badge-active" : "tab-badge-switch";
        badge.textContent = cmd.badgeText;
        metaDiv.appendChild(badge);
      } else if (cmd.shortcut) {
        const pre = document.createElement("pre");
        pre.textContent = `Alt+Shift+${formatKey(cmd.shortcut)}`;
        metaDiv.appendChild(pre);
      } else {
        const jumpSpan = document.createElement("span");
        jumpSpan.className = "jump-badge";
        jumpSpan.textContent = cmd.route ? "↵ Open | ⇧↵ Tab" : "↵ Execute";
        metaDiv.appendChild(jumpSpan);
      }

      item.appendChild(mainDiv);
      item.appendChild(metaDiv);

      item.addEventListener("click", (e) => {
        const inNewTab = e.shiftKey || e.ctrlKey || e.metaKey;
        executeCommand(cmd, inNewTab);
      });

      item.addEventListener("mouseenter", () => {
        const idx = activeCommandElements.indexOf(item);
        if (idx !== -1) {
          selectedCommandIndex = idx;
          updateSelectionHighlight();
        }
      });

      currentColUl.appendChild(item);
      activeCommandElements.push(item);
    });
  });

  container.appendChild(col1);
  container.appendChild(col2);
  fragment.appendChild(container);
  listContainer.appendChild(fragment);

  updateSelectionHighlight();
}


// Global Keyboard Listener (using capture: true on window so Angular/SecOps cannot stop propagation)
window.addEventListener("keydown", function (event) {
  if (!isContextValid()) return;

  if (event.key === "Escape") {
    const modal = document.getElementById("shortcutModal");
    if (modal && modal.style.display === "block") {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
      return;
    }
  }

  // Check if it's the Command Palette trigger:
  // 1. Alt+Shift+? / Alt+Shift+/
  // 2. Ctrl+Shift+? / Ctrl+Shift+/
  // 3. Cmd+Shift+? / Cmd+Shift+/ (Meta+Shift+?)
  // 4. Ctrl+K / Cmd+K
  const isQuestionOrSlash = event.code === "Slash" || event.key === "?" || event.key === "/" || event.keyCode === 191;
  const isAltShift = event.altKey && event.shiftKey;
  const isCtrlShift = (event.ctrlKey || event.metaKey) && event.shiftKey;
  const isCtrlK = (event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K" || event.code === "KeyK") && !event.shiftKey && !event.altKey;

  const isLauncherHotkey = (isQuestionOrSlash && (isAltShift || isCtrlShift)) || isCtrlK;

  if (isLauncherHotkey) {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.id === 'shortcutSearchInput') {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openModal();
    return;
  }

  // Direct chorded shortcuts: Alt+Shift+<Key> or Ctrl+Shift+<Key> (or Meta+Shift+<Key>)
  if (isAltShift || isCtrlShift) {
    const matchedCommand = commandCatalog.find(cmd => {
      if (!cmd.shortcut) return false;
      return cmd.shortcut === event.code || 
             formatKey(cmd.shortcut).toLowerCase() === event.key.toLowerCase();
    });

    if (matchedCommand) {
      event.preventDefault();
      event.stopPropagation();
      const prefix = isCtrlShift ? (event.metaKey ? "Cmd+Shift+" : "Ctrl+Shift+") : "Alt+Shift+";
      const readableKey = formatKey(matchedCommand.shortcut);
      console.log(`${prefix}${readableKey} sequence detected: ${matchedCommand.name}`);
      showToast(`${prefix}${readableKey}: ${matchedCommand.name}`);
      try {
        matchedCommand.action();
      } catch (err) {
        console.warn(`Action failed for ${prefix}${readableKey}:`, err);
      }
    }
  }
}, true);

/**
 * Ensures header shortcuts button is attached efficiently without continuous DOM queries.
 */
function ensureHeaderButton() {
  if (!isContextValid()) return;
  if (headerButton && headerButton.isConnected) {
    return;
  }

  const headerActionsContainer = document.querySelector('sc-navigation-header-actions');
  const userProfileButton = document.querySelector('#user-actions') || 
                            headerActionsContainer?.querySelector('sc-user-profile')?.parentElement;

  if (headerActionsContainer && userProfileButton) {
    const existing = headerActionsContainer.querySelector('.secops-shortcuts-header-button');
    if (existing) {
      headerButton = existing;
      return;
    }

    const myButton = document.createElement('button');
    myButton.setAttribute('role', 'button');
    myButton.className = 'secops-shortcuts-header-button smp-transition';
    myButton.setAttribute('aria-label', 'Open SecOps Command Palette & Shortcuts');
    myButton.title = 'Open SecOps Command Palette (Alt+Shift+?)';

    const iconImage = document.createElement('img');
    iconImage.src = isContextValid() ? chrome.runtime.getURL('icon48.png') : '';
    iconImage.alt = 'SecOps Command Palette';
    iconImage.style.width = '24px';
    iconImage.style.height = '24px';
    iconImage.style.verticalAlign = 'middle';

    myButton.appendChild(iconImage);
    myButton.style.backgroundColor = 'transparent';
    myButton.style.border = 'none';
    myButton.style.cursor = 'pointer';
    myButton.style.padding = '8px';
    myButton.style.borderRadius = '50%';
    myButton.style.display = 'inline-flex';
    myButton.style.alignItems = 'center';
    myButton.style.justifyContent = 'center';

    myButton.addEventListener('click', openModal);

    headerActionsContainer.insertBefore(myButton, userProfileButton);
    headerButton = myButton;
  }
}

// Unified debounced mutation runner
let mutationScheduled = false;
function scheduleMutationPass() {
  if (!isContextValid()) return;
  if (mutationScheduled) return;
  mutationScheduled = true;
  requestAnimationFrame(() => {
    if (!isContextValid()) return;
    ensureHeaderButton();
    renderMarkdownInPage(document);
    mutationScheduled = false;
  });
}

// Ultra-lightweight MutationObserver: single RAF tick handles DOM checks
const appObserver = new MutationObserver((mutations) => {
  if (!isContextValid()) {
    appObserver.disconnect();
    return;
  }

  let hasRelevantMutation = false;
  
  if (!headerButton || !headerButton.isConnected) {
    hasRelevantMutation = true;
  }

  if (!hasRelevantMutation) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList?.contains('search-markers') ||
              node.classList?.contains('evidence-activity-comment') ||
              node.classList?.contains('case-wall-item-name-automation') ||
              node.tagName === 'COMMENT-ACTIVITY' ||
              node.tagName === 'WALL-EVIDENCE-ACTIVITY' ||
              node.querySelector?.('.search-markers, comment-activity, .evidence-activity-comment, wall-evidence-activity')) {
            hasRelevantMutation = true;
            break;
          }
        }
      }
      if (hasRelevantMutation) break;
    }
  }

  if (hasRelevantMutation) {
    scheduleMutationPass();
  }
});


appObserver.observe(document.body, { childList: true, subtree: true });

// Initialize Turbo Mode (Applies on startup)
applyTurboMode(getTurboModePreference());

// Initialize Modal & First Pass
insertModal();
scheduleMutationPass();