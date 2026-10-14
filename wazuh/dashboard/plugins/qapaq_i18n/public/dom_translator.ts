/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Traductor de la UI renderizada (solo navegador). Capa 1: glosario curado
 * (determinista). Capa 2: Translator API integrada del navegador (on-device), si existe.
 * Nunca llama a servicios de traducción por red (Res. SBS 504-2021; Ley 29733).
 */

import {
  applyBrand,
  Glossary,
  isEligibleForMachineTranslation,
  isExcluded,
  isSelfExcludedByMarkers,
  splitWhitespace,
  translateText,
  translateTitle,
} from '../common/translate';

const ATTRS = ['placeholder', 'title', 'aria-label'];
const FRAME_BUDGET_MS = 8;
const MAX_ITEMS_PER_TICK = 400;
const MT_CACHE_KEY = 'qapaq.i18n.mt.v1';
const MT_CACHE_MAX = 3000;

type Work = Node;

interface OnDeviceTranslator {
  translate(text: string): Promise<string>;
}

interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<OnDeviceTranslator>;
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class DomTranslator {
  private readonly g: Glossary;
  private readonly doc: Document;
  private readonly queue = new Set<Work>();
  /** Último valor que escribimos en cada nodo de texto: evita bucles con el observer. */
  private readonly written = new WeakMap<Node, string>();
  /** Último valor escrito por atributo, por elemento. */
  private readonly writtenAttr = new WeakMap<Element, Record<string, string>>();
  private readonly exclusionCache = new WeakMap<object, boolean>();
  private observer: MutationObserver | null = null;
  private scheduled = false;

  // Capa 2 (on-device)
  private mt: OnDeviceTranslator | null = null;
  private mtMemo = new Map<string, string>();
  private mtPending = new Map<string, Set<Text>>();
  private mtQueue: string[] = [];
  private mtRunning = false;

  constructor(glossary: Glossary, doc: Document = document) {
    this.g = glossary;
    this.doc = doc;
  }

  start(): void {
    const html = this.doc.documentElement;
    html.setAttribute('lang', 'es');
    this.loadMtCache();
    this.translateDocumentTitle();

    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(html, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS, 'lang'],
    });

    if (this.doc.body) this.enqueue(this.doc.body);
    this.doc.addEventListener('visibilitychange', () => {
      if (!this.doc.hidden && this.queue.size) this.schedule();
    });
    void this.initOnDevice();
  }

  /* ------------------------------ observación y lotes ------------------------------ */

  private onMutations(records: MutationRecord[]): void {
    for (const r of records) {
      if (r.type === 'childList') {
        if (r.target.nodeName === 'TITLE') {
          this.translateDocumentTitle();
          continue;
        }
        r.addedNodes.forEach((n) => this.enqueue(n));
      } else if (r.type === 'characterData') {
        if (r.target.parentNode && r.target.parentNode.nodeName === 'TITLE') {
          this.translateDocumentTitle();
          continue;
        }
        this.enqueue(r.target);
      } else if (r.type === 'attributes') {
        const el = r.target as Element;
        if (r.attributeName === 'lang') {
          if (el === this.doc.documentElement && el.getAttribute('lang') !== 'es') {
            el.setAttribute('lang', 'es');
          }
        } else this.enqueue(el);
      }
    }
  }

  private enqueue(n: Node): void {
    if (n.nodeType === 3 || n.nodeType === 1) {
      this.queue.add(n);
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.scheduled || this.doc.hidden) return;
    this.scheduled = true;
    const w = window as Window & {
      requestIdleCallback?: (
        cb: (d: { timeRemaining(): number }) => void,
        o?: { timeout: number },
      ) => number;
    };
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback((d) => this.flush(() => d.timeRemaining() > 1), { timeout: 300 });
    } else {
      window.requestAnimationFrame(() => {
        const t0 = performance.now();
        this.flush(() => performance.now() - t0 < FRAME_BUDGET_MS);
      });
    }
  }

  private flush(hasTime: () => boolean): void {
    this.scheduled = false;
    if (this.doc.hidden) return;
    let done = 0;
    const it = this.queue.values();
    while (done < MAX_ITEMS_PER_TICK && hasTime()) {
      const next = it.next();
      if (next.done) break;
      const node = next.value;
      this.queue.delete(node);
      done++;
      if (!node.isConnected) continue;
      if (node.nodeType === 3) this.processText(node as Text);
      else this.processElement(node as Element);
    }
    if (this.queue.size) this.schedule();
  }

  /** Expande un elemento: atributos propios + nodos de texto descendientes (encolados). */
  private processElement(el: Element): void {
    if (isExcluded(el.parentElement, this.exclusionCache)) return;
    this.processAttributes(el);
    if (isExcluded(el, this.exclusionCache)) return;
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === 1) {
          return isExcluded(n as Element, this.exclusionCache)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) this.queue.add(n);
      else if ((n as Element).attributes.length) this.processAttributes(n as Element);
      n = walker.nextNode();
    }
  }

  private processText(node: Text): void {
    const raw = node.data;
    if (!raw || this.written.get(node) === raw) return; // nuestro propio cambio o ya hecho
    if (!/[A-Za-z]/.test(raw)) return;
    if (isExcluded(node.parentElement, this.exclusionCache)) return;
    const out = translateText(this.g, raw);
    if (out !== null) {
      this.written.set(node, out);
      node.data = out;
      return;
    }
    this.written.set(node, raw); // no reintentar este mismo contenido
    this.maybeMachineTranslate(node, raw);
  }

  private processAttributes(el: Element): void {
    // Los atributos de <input>/<textarea> (placeholder) sí se traducen; su valor nunca.
    if (isSelfExcludedByMarkers(el) || isExcluded(el.parentElement, this.exclusionCache)) return;
    let memo = this.writtenAttr.get(el);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || (memo && memo[a] === v) || !/[A-Za-z]/.test(v)) continue;
      const out = translateText(this.g, v);
      if (!memo) {
        memo = {};
        this.writtenAttr.set(el, memo);
      }
      memo[a] = out === null ? v : out;
      if (out !== null) el.setAttribute(a, out);
    }
  }

  private translateDocumentTitle(): void {
    const t = this.doc.title;
    if (!t) return;
    const out = translateTitle(this.g, t);
    if (out !== t) this.doc.title = out;
  }

  /* ------------------------------ capa 2: on-device ------------------------------ */

  private async initOnDevice(): Promise<void> {
    const T = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
    if (!T || typeof T.availability !== 'function' || typeof T.create !== 'function') return;
    const opts = { sourceLanguage: 'en', targetLanguage: 'es' };
    let state: string;
    try {
      state = await T.availability(opts);
    } catch {
      return;
    }
    const create = async () => {
      try {
        this.mt = await T.create(opts);
        this.pumpMt();
      } catch {
        this.mt = null;
      }
    };
    if (state === 'available') {
      await create();
    } else if (state === 'downloadable' || state === 'downloading') {
      // Descargar el modelo de idioma exige activación del usuario: se espera al primer gesto.
      const once = () => {
        this.doc.removeEventListener('pointerdown', once, true);
        this.doc.removeEventListener('keydown', once, true);
        void create();
      };
      this.doc.addEventListener('pointerdown', once, true);
      this.doc.addEventListener('keydown', once, true);
    }
    // 'unavailable' u otro: no se hace nada más.
  }

  private maybeMachineTranslate(node: Text, raw: string): void {
    const [, core] = splitWhitespace(raw);
    if (!isEligibleForMachineTranslation(this.g, core)) return;
    const cached = this.mtMemo.get(core);
    if (cached !== undefined) {
      this.applyMt(node, core, cached);
      return;
    }
    let waiting = this.mtPending.get(core);
    if (!waiting) {
      waiting = new Set();
      this.mtPending.set(core, waiting);
      this.mtQueue.push(core);
    }
    waiting.add(node);
    this.pumpMt();
  }

  private applyMt(node: Text, core: string, translated: string): void {
    if (!node.isConnected) return;
    const raw = node.data;
    const [lead, current, trail] = splitWhitespace(raw);
    if (current !== core) return; // el nodo cambió mientras se traducía
    const out = lead + applyBrand(this.g, translated) + trail;
    if (out === raw || core === translated) return;
    this.written.set(node, out);
    node.data = out;
  }

  private async pumpMt(): Promise<void> {
    if (!this.mt || this.mtRunning) return;
    this.mtRunning = true;
    try {
      while (this.mtQueue.length && this.mt) {
        if (this.doc.hidden) break;
        const core = this.mtQueue.shift() as string;
        const nodes = this.mtPending.get(core);
        this.mtPending.delete(core);
        let translated: string;
        try {
          translated = (await this.mt.translate(core)).trim();
        } catch {
          continue;
        }
        if (!translated) continue;
        this.mtMemo.set(core, translated);
        this.saveMtCache();
        if (nodes) nodes.forEach((n) => this.applyMt(n, core, translated));
      }
    } finally {
      this.mtRunning = false;
    }
  }

  private loadMtCache(): void {
    const s = safeSession();
    if (!s) return;
    try {
      const data = JSON.parse(s.getItem(MT_CACHE_KEY) || '{}') as Record<string, string>;
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') this.mtMemo.set(k, v);
    } catch {
      /* caché corrupta o almacenamiento bloqueado: se ignora */
    }
  }

  private saveTimer: number | null = null;
  private saveMtCache(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const s = safeSession();
      if (!s) return;
      try {
        const entries = [...this.mtMemo.entries()].slice(-MT_CACHE_MAX);
        s.setItem(MT_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch {
        /* cuota excedida o bloqueado */
      }
    }, 1000);
  }
}
