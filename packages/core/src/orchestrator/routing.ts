/**
 * Which requests a lighter (cheaper, faster) model can answer: short questions about the project
 * that ask for an explanation, not for changes. Deliberately conservative - anything that sounds
 * like work (fix, add, create, düzelt, ekle, ...) goes to the main model. If the light model
 * still tries to change something, the orchestrator hands the request back to the main model.
 */
const ACTION_EN =
  /\b(fix|add|create|implement|build|write|refactor|rename|delete|remove|update|upgrade|change|install|migrate|generate|make|convert|move|set ?up|deploy|commit|push|run|test|debug|optimi[sz]e|improve|replace|edit|port)\b/i;
// Turkish verb stems in imperative/request forms ("düzelt", "ekler misin", "oluşturalım", "yapar mısın").
const ACTION_TR = /(düzelt|ekle|oluştur|yaz(?!ı)|değiştir|sil(?!ik)|kaldır|kur(?!al)|güncelle|taşı|dönüştür|üret|çalıştır|yap(?!ı)|hallet|geliştir|iyileştir|temizle|bağla)/i;
const QUESTION_EN = /\?\s*$|^(what|why|how|where|which|who|when|does|do|is|are|can|could|should|explain|describe|summari[sz]e|tell me|show me|list)\b/i;
const QUESTION_TR = /\?\s*$|\b(nedir|neden|niye|nasıl|nerede|nereden|hangi|kim|ne zaman|ne işe|açıkla|anlat|özetle|göster|listele)\b|\b(mı|mi|mu|mü)\b/i;

export function isSimpleRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500 || trimmed.includes('\n\n')) return false;
  if (ACTION_EN.test(trimmed) || ACTION_TR.test(trimmed)) return false;
  return QUESTION_EN.test(trimmed) || QUESTION_TR.test(trimmed);
}
