export interface ApiLikeError {
  status?: number;
  detail?: string | object;
  message?: string;
  name?: string;
}

/** Человекочитаемое сообщение для ошибок генерации, API и общих сбоев. */
export function humanizeErrorMessage(raw: unknown): string {
  if (raw == null) return "";

  let text = "";
  if (raw && typeof raw === "object" && "detail" in raw) {
    const obj = raw as ApiLikeError;
    const detail = obj.detail;
    text = obj.message || (typeof detail === "string" ? detail : JSON.stringify(detail));
  } else if (raw instanceof Error) {
    text = raw.message || String(raw);
  } else if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }

  text = text.trim();
  if (!text) return "";

  const low = text.toLowerCase();

  // 1. Отмена
  if (low.includes("отменен") || low.includes("cancel")) {
    return "Генерация отменена пользователем";
  }

  // 2. Баланс и кредиты
  if (
    low.includes("insufficient balance") ||
    low.includes("balance is insufficient") ||
    low.includes("insufficient credit") ||
    low.includes("insufficient_credit") ||
    low.includes("out of credit") ||
    low.includes("quota") ||
    low.includes("credits exhausted") ||
    low.includes("нет кредит") ||
    low.includes("баланс исчерпан") ||
    low.includes("not enough credits") ||
    low.includes("code 4001") ||
    low.includes("4001")
  ) {
    return "Закончились средства на балансе провайдера — пополните счёт";
  }

  // 3. Цензура и модерация
  if (
    low.includes("moderation") ||
    low.includes("violate") ||
    low.includes("policy") ||
    low.includes("nsfw") ||
    low.includes("sensitive") ||
    low.includes("banned") ||
    low.includes("safety") ||
    low.includes("content filter") ||
    low.includes("отклонён фильтром")
  ) {
    return "Промпт отклонён фильтром безопасности — смягчите описание";
  }

  // 4. Лимит запросов (Rate Limit / 429)
  if (low.includes("429") || low.includes("rate limit") || low.includes("too many requests")) {
    return "Превышен лимит запросов к сервису — подождите 1–2 минуты";
  }

  // 5. Сервер перегружен / упал шлюз (500, 502, 503, 504, Bad Gateway)
  if (
    low.includes("502 bad gateway") ||
    low.includes("504 gateway") ||
    low.includes("bad gateway") ||
    low.includes("gateway timeout") ||
    low.includes("internal server error") ||
    low.includes("500 internal") ||
    low.includes("service unavailable") ||
    low.includes("upstream_error") ||
    /\b(500|502|503|504)\b/.test(low)
  ) {
    return "Сервер временно перегружен или недоступен — повторите через 1–2 минуты";
  }

  // 6. Ключ и авторизация (401 / 403)
  if (
    low.includes("apikey error") ||
    low.includes("invalid api key") ||
    low.includes("not authorized") ||
    low.includes("unauthorized") ||
    low.includes("forbidden") ||
    low.includes("401") ||
    low.includes("403") ||
    low.includes("нет api ключ")
  ) {
    return "Неверный ключ доступа (API-ключ) — проверьте настройки";
  }

  // 7. Таймаут
  if (low.includes("timeout") || low.includes("timed out") || low.includes("таймаут")) {
    return "Превышено время ожидания ответа — попробуйте повторить";
  }

  // 8. Сеть
  if (
    low.includes("connection refused") ||
    low.includes("failed to fetch") ||
    low.includes("network error") ||
    low.includes("connecterror")
  ) {
    return "Ошибка связи с сервером — проверьте интернет или шлюз";
  }

  // 9. Слишком длинный промпт
  if (low.includes("too long") || low.includes("prompt length") || low.includes("слишком длинн")) {
    return "Промпт слишком длинный для этой модели — сократите описание";
  }

  // Вычищаем технические префиксы и дампы JSON
  let cleaned = text
    .replace(/^(?:[a-zA-Z_]\w*\.)*[a-zA-Z_]\w*(?:Error|Exception)\s*:\s*/i, "")
    .replace(/^(?:(?:GPT\s+)?HTTP\s*)?\d{3}(?:\s+[\w\s]+)?\s*[:—\-]?\s*/i, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  // Если внутри есть JSON {"message": "..."}, достаем его
  if (cleaned.includes("{") && cleaned.includes("}")) {
    try {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const inner =
          parsed?.error?.message ||
          parsed?.error?.msg ||
          parsed?.message ||
          parsed?.msg ||
          parsed?.detail;
        if (typeof inner === "string" && inner.trim()) {
          return humanizeErrorMessage(inner);
        }
      }
    } catch {
      // Игнорируем ошибку парсинга JSON
    }
    cleaned = cleaned.replace(/\{[\s\S]*\}/g, "").trim();
  }

  // Убираем кавычки и двоеточия
  cleaned = cleaned.replace(/^['"`:\s—-]+|['"`:\s—-]+$/g, "").trim();

  if (/[А-Яа-яЁё]/.test(cleaned) && cleaned.length > 3) {
    return cleaned.slice(0, 200);
  }

  return "Действие временно не выполнено — попробуйте повторить";
}

/** Человекочитаемое сообщение для toast / alert из любой ошибки API или unknown. */
export function errorMessageFromUnknown(err: unknown): string {
  return humanizeErrorMessage(err);
}
