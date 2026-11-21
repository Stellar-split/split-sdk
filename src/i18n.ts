/**
 * Internationalization (i18n) support for StellarSplit SDK (Issue #1049).
 *
 * Multi-language support for SDK error messages and UI strings:
 * - Bundled translations (en, es, fr, de, pt, zh, ja)
 * - BCP-47 language detection with safe fallback to English
 * - Runtime locale switching with {named} interpolation
 * - Extensible via registerTranslations / registerLocale
 */

export type SupportedLocale = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja';
export type LocaleCode = SupportedLocale | (string & {});
export type TranslationDict = Record<string, string>;
export type LocaleDicts = Record<string, TranslationDict>;

/** Default (fallback) locale. */
export const DEFAULT_LOCALE = 'en';
/** Locales bundled with the SDK. */
export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'es', 'fr', 'de', 'pt', 'zh', 'ja'];

export type LocaleChangeListener = (locale: string, previous: string) => void;

const customDicts: LocaleDicts = {};
const listeners = new Set<LocaleChangeListener>();
let currentLocale: string = DEFAULT_LOCALE;

function normalizeLocale(tag: string | null | undefined): string | null {
  if (!tag || typeof tag !== 'string') return null;
  const cleaned = tag.trim().replace(/_/g, '-').toLowerCase();
  if (!cleaned) return null;
  const all = { ...BUILTIN, ...customDicts };
  if (all[cleaned]) return cleaned;
  const base = cleaned.split('-')[0];
  if (base && all[base]) return base;
  // Unsupported locale — signal fallback to the default.
  return null;
}

/**
 * Parse an Accept-Language header (e.g. "fr-CH, fr;q=0.9, en;q=0.8")
 * and return the first supported locale, or null.
 */
export function detectFromAcceptLanguage(header: string | null | undefined): string | null {
  if (!header || typeof header !== 'string') return null;
  const entries = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m) {
          const parsed = Number(m[1]);
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { tag: (tag ?? '').trim(), q };
    })
    .filter((e) => e.tag.length > 0)
    .sort((a, b) => b.q - a.q);
  for (const entry of entries) {
    const detected = normalizeLocale(entry.tag);
    if (detected) return detected;
  }
  return null;
}

/**
 * Detect the user's preferred language.
 * Order: explicit hint > query param (lang/locale) > Accept-Language header >
 * navigator.language (browser) > LANGUAGE/LC_ALL/LANG env vars (Node) >
 * English fallback.
 */
export function detectLanguage(hint?: string | null): string {
  const fromHint = normalizeLocale(hint ?? null);
  if (fromHint) return fromHint;
  try {
    const search = (globalThis as any).location?.search;
    if (typeof search === 'string' && search.length > 1) {
      const params = new URLSearchParams(search);
      const fromQuery = normalizeLocale(params.get('lang') ?? params.get('locale'));
      if (fromQuery) return fromQuery;
    }
  } catch {}
  try {
    const nav = (globalThis as any).navigator;
    const fromAccept = detectFromAcceptLanguage(nav?.languages?.[0] ?? null);
    if (fromAccept) return fromAccept;
    const fromNav = normalizeLocale(typeof nav?.language === 'string' ? nav.language : null);
    if (fromNav) return fromNav;
  } catch {}
  try {
    const env = (globalThis as any).process?.env;
    if (env) {
      for (const key of ['LANGUAGE', 'LC_ALL', 'LANG']) {
        const raw = env[key];
        if (!raw) continue;
        const first = String(raw).split(':')[0]!.split('.')[0]!;
        const detected = normalizeLocale(first);
        if (detected) return detected;
      }
    }
  } catch {}
  return DEFAULT_LOCALE;
}

/** Get the currently active locale. */
export function getLocale(): string { return currentLocale; }

/**
 * Switch the active locale. Unsupported locales fall back to the default.
 * Notifies registered listeners when the locale actually changes.
 */
export function setLocale(locale: string): string {
  const next = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const previous = currentLocale;
  currentLocale = next;
  if (next !== previous) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(next, previous);
      } catch {}
    }
  }
  return currentLocale;
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(listener: LocaleChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listLocales(): string[] {
  return Array.from(new Set([...Object.keys(BUILTIN), ...Object.keys(customDicts)]));
}

export function registerTranslations(locale: string, dict: TranslationDict): string {
  const key = locale.trim().replace(/_/g, '-').toLowerCase();
  if (!key) return currentLocale;
  customDicts[key] = { ...(customDicts[key] ?? {}), ...dict };
  return key;
}
export const registerLocale = registerTranslations;

export function _resetI18nForTesting(): void {
  currentLocale = DEFAULT_LOCALE;
  listeners.clear();
  for (const k of Object.keys(customDicts)) delete customDicts[k];
}

function lookup(key: string, locale: string): string | undefined {
  return customDicts[locale]?.[key] ?? BUILTIN[locale]?.[key];
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/{(\w+)}/g, (m, name) =>
    params[name] !== undefined && params[name] !== null ? String(params[name]) : m
  );
}

export function t(key: string, params?: Record<string, unknown>, locale?: string): string {
  const active = normalizeLocale(locale ?? currentLocale) ?? DEFAULT_LOCALE;
  const template =
    lookup(key, active) ??
    lookup(key, active.split('-')[0] ?? active) ??
    lookup(key, DEFAULT_LOCALE) ??
    key;
  return interpolate(template, params);
}

export function translateErrorCode(code: string, params?: Record<string, unknown>, locale?: string): string {
  const key = `error.${code.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`;
  const template = t(key, params, locale);
  return template === key ? t('error.generic', params, locale) : template;
}

export function translateStatus(status: string, locale?: string): string {
  return t(`invoice.status.${String(status).toLowerCase()}`, undefined, locale);
}

export function tp(keyOne: string, keyOther: string, count: number, params?: Record<string, unknown>, locale?: string): string {
  return t(count === 1 ? keyOne : keyOther, { ...(params ?? {}), count }, locale);
}

/**
 * Translation management: return the merged dictionary for a locale
 * (custom overrides take precedence over bundled strings).
 */
export function getTranslations(locale: string): TranslationDict {
  const key = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return { ...(BUILTIN[key] ?? {}), ...(customDicts[key] ?? {}) };
}

/** Translation management: list keys missing from a locale vs. the default. */
export function getMissingTranslations(locale: string): string[] {
  const key = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const dict = getTranslations(key);
  return Object.keys(BUILTIN[DEFAULT_LOCALE] ?? {}).filter((k) => dict[k] === undefined);
}

/**
 * Localized template metadata helper, intended for integration with the
 * template manager. Returns a localized name/description for a template id.
 */
export function translateTemplateName(templateId: string, locale?: string): string {
  return t(`template.${templateId}.name`, undefined, locale);
}

export function translateTemplateDescription(templateId: string, locale?: string): string {
  return t(`template.${templateId}.description`, undefined, locale);
}


const EN: TranslationDict = {"error.invoiceNotFound": "Invoice not found: {invoiceId}", "error.invoiceNotPending": "Invoice is not in Pending state: {invoiceId}", "error.deadlinePassed": "Invoice deadline has passed: {invoiceId}", "error.insufficientBalance": "Insufficient balance: requested {amount}, remaining {remaining} (invoice {invoiceId})", "error.paymentExceedsRemaining": "Payment exceeds remaining balance: {amount} > {remaining}", "error.invoiceFrozen": "Invoice is frozen: {invoiceId}", "error.unauthorized": "Unauthorized: {reason}", "error.validation": "Validation failed: {reason}", "error.transactionFailed": "Transaction failed: {reason}", "error.walletNotConnected": "Wallet is not connected", "error.unknownExportFormat": "Unknown export format: {format}", "error.subscriptionNotFound": "Subscription not found: {subscriptionId}", "error.tooEarlyToTrigger": "Too early to trigger subscription: {subscriptionId}", "error.generic": "An unexpected error occurred: {reason}", "invoice.status.pending": "Pending", "invoice.status.released": "Released", "invoice.status.refunded": "Refunded", "invoice.status.cancelled": "Cancelled", "invoice.export.title": "StellarSplit Invoice", "invoice.export.recipients": "Recipients", "invoice.export.payments": "Payments", "invoice.export.id": "ID", "invoice.export.creator": "Creator", "invoice.export.status": "Status", "invoice.export.token": "Token", "invoice.export.deadline": "Deadline", "invoice.export.funded": "Funded", "ui.pay": "Pay", "ui.release": "Release", "ui.refund": "Refund", "ui.cancel": "Cancel", "ui.loading": "Loading…", "ui.confirm": "Confirm", "ui.close": "Close"};

const ES: TranslationDict = {"error.invoiceNotFound": "Factura no encontrada: {invoiceId}", "error.invoiceNotPending": "La factura no está en estado Pendiente: {invoiceId}", "error.deadlinePassed": "El plazo de la factura ha vencido: {invoiceId}", "error.insufficientBalance": "Saldo insuficiente: solicitado {amount}, restante {remaining} (factura {invoiceId})", "error.paymentExceedsRemaining": "El pago excede el saldo restante: {amount} > {remaining}", "error.invoiceFrozen": "La factura está congelada: {invoiceId}", "error.unauthorized": "No autorizado: {reason}", "error.validation": "Validación fallida: {reason}", "error.transactionFailed": "Transacción fallida: {reason}", "error.walletNotConnected": "La billetera no está conectada", "error.unknownExportFormat": "Formato de exportación desconocido: {format}", "error.subscriptionNotFound": "Suscripción no encontrada: {subscriptionId}", "error.tooEarlyToTrigger": "Demasiado pronto para activar la suscripción: {subscriptionId}", "error.generic": "Ocurrió un error inesperado: {reason}", "invoice.status.pending": "Pendiente", "invoice.status.released": "Liberada", "invoice.status.refunded": "Reembolsada", "invoice.status.cancelled": "Cancelada", "invoice.export.title": "Factura de StellarSplit", "invoice.export.recipients": "Destinatarios", "invoice.export.payments": "Pagos", "invoice.export.id": "ID", "invoice.export.creator": "Creador", "invoice.export.status": "Estado", "invoice.export.token": "Token", "invoice.export.deadline": "Vencimiento", "invoice.export.funded": "Financiado", "ui.pay": "Pagar", "ui.release": "Liberar", "ui.refund": "Reembolsar", "ui.cancel": "Cancelar", "ui.loading": "Cargando…", "ui.confirm": "Confirmar", "ui.close": "Cerrar"};

const FR: TranslationDict = {"error.invoiceNotFound": "Facture introuvable : {invoiceId}", "error.invoiceNotPending": "La facture n'est pas en état En attente : {invoiceId}", "error.deadlinePassed": "La date limite de la facture est dépassée : {invoiceId}", "error.insufficientBalance": "Solde insuffisant : demandé {amount}, restant {remaining} (facture {invoiceId})", "error.paymentExceedsRemaining": "Le paiement dépasse le solde restant : {amount} > {remaining}", "error.invoiceFrozen": "La facture est gelée : {invoiceId}", "error.unauthorized": "Non autorisé : {reason}", "error.validation": "Échec de validation : {reason}", "error.transactionFailed": "Transaction échouée : {reason}", "error.walletNotConnected": "Le portefeuille n'est pas connecté", "error.unknownExportFormat": "Format d'export inconnu : {format}", "error.subscriptionNotFound": "Abonnement introuvable : {subscriptionId}", "error.tooEarlyToTrigger": "À trôt tôt pour déclencher l’abonnement : {subscriptionId}", "error.generic": "Une erreur inattendue est survenue : {reason}", "invoice.status.pending": "En attente", "invoice.status.released": "Libérée", "invoice.status.refunded": "Remboursée", "invoice.status.cancelled": "Annulée", "invoice.export.title": "Facture StellarSplit", "invoice.export.recipients": "Destinataires", "invoice.export.payments": "Paiements", "invoice.export.id": "ID", "invoice.export.creator": "Créateur", "invoice.export.status": "Statut", "invoice.export.token": "Jeton", "invoice.export.deadline": "Échéance", "invoice.export.funded": "Financé", "ui.pay": "Payer", "ui.release": "Libérer", "ui.refund": "Rembourser", "ui.cancel": "Annuler", "ui.loading": "Chargement…", "ui.confirm": "Confirmer", "ui.close": "Fermer"};

const DE: TranslationDict = {"error.invoiceNotFound": "Rechnung nicht gefunden: {invoiceId}", "error.invoiceNotPending": "Rechnung ist nicht im Status Ausstehend: {invoiceId}", "error.deadlinePassed": "Rechnungsfrist überschritten: {invoiceId}", "error.insufficientBalance": "Unzureichendes Guthaben: angefordert {amount}, verbleibend {remaining} (Rechnung {invoiceId})", "error.paymentExceedsRemaining": "Zahlung übersteigt Restbetrag: {amount} > {remaining}", "error.invoiceFrozen": "Rechnung ist eingefroren: {invoiceId}", "error.unauthorized": "Nicht autorisiert: {reason}", "error.validation": "Validierung fehlgeschlagen: {reason}", "error.transactionFailed": "Transaktion fehlgeschlagen: {reason}", "error.walletNotConnected": "Wallet ist nicht verbunden", "error.unknownExportFormat": "Unbekanntes Exportformat: {format}", "error.subscriptionNotFound": "Abonnement nicht gefunden: {subscriptionId}", "error.tooEarlyToTrigger": "Zu früh zum Auslösen des Abonnements: {subscriptionId}", "error.generic": "Ein unerwarteter Fehler ist aufgetreten: {reason}", "invoice.status.pending": "Ausstehend", "invoice.status.released": "Freigegeben", "invoice.status.refunded": "Erstattet", "invoice.status.cancelled": "Storniert", "invoice.export.title": "StellarSplit-Rechnung", "invoice.export.recipients": "Empfänger", "invoice.export.payments": "Zahlungen", "invoice.export.id": "ID", "invoice.export.creator": "Ersteller", "invoice.export.status": "Status", "invoice.export.token": "Token", "invoice.export.deadline": "Fälligkeit", "invoice.export.funded": "Finanziert", "ui.pay": "Zahlen", "ui.release": "Freigeben", "ui.refund": "Erstatten", "ui.cancel": "Abbrechen", "ui.loading": "Wird geladen…", "ui.confirm": "Bestätigen", "ui.close": "Schließen"};

const PT: TranslationDict = {"error.invoiceNotFound": "Fatura não encontrada: {invoiceId}", "error.invoiceNotPending": "A fatura não está no estado Pendente: {invoiceId}", "error.deadlinePassed": "O prazo da fatura expirou: {invoiceId}", "error.insufficientBalance": "Saldo insuficiente: solicitado {amount}, restante {remaining} (fatura {invoiceId})", "error.paymentExceedsRemaining": "O pagamento excede o saldo restante: {amount} > {remaining}", "error.invoiceFrozen": "A fatura está congelada: {invoiceId}", "error.unauthorized": "Não autorizado: {reason}", "error.validation": "Falha na validação: {reason}", "error.transactionFailed": "Transação falhou: {reason}", "error.walletNotConnected": "A carteira não está conectada", "error.unknownExportFormat": "Formato de exportação desconhecido: {format}", "error.subscriptionNotFound": "Assinatura não encontrada: {subscriptionId}", "error.tooEarlyToTrigger": "Muito cedo para acionar a assinatura: {subscriptionId}", "error.generic": "Ocorreu um erro inesperado: {reason}", "invoice.status.pending": "Pendente", "invoice.status.released": "Liberada", "invoice.status.refunded": "Reembolsada", "invoice.status.cancelled": "Cancelada", "invoice.export.title": "Fatura StellarSplit", "invoice.export.recipients": "Destinatários", "invoice.export.payments": "Pagamentos", "invoice.export.id": "ID", "invoice.export.creator": "Criador", "invoice.export.status": "Status", "invoice.export.token": "Token", "invoice.export.deadline": "Vencimento", "invoice.export.funded": "Financiado", "ui.pay": "Pagar", "ui.release": "Liberar", "ui.refund": "Reembolsar", "ui.cancel": "Cancelar", "ui.loading": "Carregando…", "ui.confirm": "Confirmar", "ui.close": "Fechar"};

const ZH: TranslationDict = {"error.invoiceNotFound": "本发票不存在：{invoiceId}", "error.invoiceNotPending": "发票不在待处理状态：{invoiceId}", "error.deadlinePassed": "发票已过期：{invoiceId}", "error.insufficientBalance": "余额不足：请求 {amount}，剩余 {remaining}（发票 {invoiceId}）", "error.paymentExceedsRemaining": "付款超出剩余金额：{amount} > {remaining}", "error.invoiceFrozen": "发票已冻结：{invoiceId}", "error.unauthorized": "未授权：{reason}", "error.validation": "验证失败：{reason}", "error.transactionFailed": "交易失败：{reason}", "error.walletNotConnected": "钱包未连接", "error.unknownExportFormat": "未知的导出格式：{format}", "error.subscriptionNotFound": "未找到订阅：{subscriptionId}", "error.tooEarlyToTrigger": "触发订阅过早：{subscriptionId}", "error.generic": "发生意外错误：{reason}", "invoice.status.pending": "待处理", "invoice.status.released": "已发放", "invoice.status.refunded": "已退款", "invoice.status.cancelled": "已取消", "invoice.export.title": "StellarSplit 发票", "invoice.export.recipients": "收款人", "invoice.export.payments": "付款", "invoice.export.id": "编号", "invoice.export.creator": "创建者", "invoice.export.status": "状态", "invoice.export.token": "代币", "invoice.export.deadline": "截止日期", "invoice.export.funded": "已筹集", "ui.pay": "支付", "ui.release": "发放", "ui.refund": "退款", "ui.cancel": "取消", "ui.loading": "加载中…", "ui.confirm": "确认", "ui.close": "关闭"};

const JA: TranslationDict = {"error.invoiceNotFound": "請求書が見つかりません: {invoiceId}", "error.invoiceNotPending": "請求書は保留中ではありません: {invoiceId}", "error.deadlinePassed": "請求書の期限が過ぎています: {invoiceId}", "error.insufficientBalance": "残高不足: 要求 {amount}、残り {remaining}（請求書 {invoiceId}）", "error.paymentExceedsRemaining": "支払いが残高を超過しています: {amount} > {remaining}", "error.invoiceFrozen": "請求書は凍結されています: {invoiceId}", "error.unauthorized": "権限がありません: {reason}", "error.validation": "検証に失敗しました: {reason}", "error.transactionFailed": "トランザクションに失敗しました: {reason}", "error.walletNotConnected": "ウォレットが接続されていません", "error.unknownExportFormat": "不明なエクスポート形式: {format}", "error.subscriptionNotFound": "サブスクリプションが見つかりません: {subscriptionId}", "error.tooEarlyToTrigger": "サブスクリプションの実行には早すぎます: {subscriptionId}", "error.generic": "予期しないエラーが発生しました: {reason}", "invoice.status.pending": "保留中", "invoice.status.released": "リリース済み", "invoice.status.refunded": "返金済み", "invoice.status.cancelled": "キャンセル済み", "invoice.export.title": "StellarSplit請求書", "invoice.export.recipients": "受取人", "invoice.export.payments": "支払い", "invoice.export.id": "ID", "invoice.export.creator": "作成者", "invoice.export.status": "ステータス", "invoice.export.token": "トークン", "invoice.export.deadline": "期限", "invoice.export.funded": "調達済み", "ui.pay": "支払う", "ui.release": "リリース", "ui.refund": "返金", "ui.cancel": "キャンセル", "ui.loading": "読み込み中…", "ui.confirm": "確認", "ui.close": "閉じる"};

const BUILTIN: LocaleDicts = { en: EN, es: ES, fr: FR, de: DE, pt: PT, zh: ZH, ja: JA };

/** The full i18n API, convenient for re-export from the package index. */
export const i18n = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLanguage,
  detectFromAcceptLanguage,
  getLocale,
  setLocale,
  onLocaleChange,
  listLocales,
  registerTranslations,
  registerLocale,
  getTranslations,
  getMissingTranslations,
  t,
  tp,
  translateErrorCode,
  translateStatus,
  translateTemplateName,
  translateTemplateDescription,
};
