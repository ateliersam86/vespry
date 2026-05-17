/**
 * Webhook Ko-Fi.
 *
 * Ko-Fi POST un corps `application/x-www-form-urlencoded` avec un seul champ
 * `data` contenant un JSON. L'authenticité est portée par `verification_token`
 * (à comparer au secret KOFI_VERIFICATION_TOKEN, défini côté Ko-Fi et Worker).
 *
 * Référence : https://ko-fi.com/manage/webhooks
 */

export interface KofiPayload {
  verificationToken: string;
  /** Identifiant unique du message — sert à l'idempotence. */
  messageId: string;
  /** ISO 8601. */
  timestamp: string;
  /** 'Donation' | 'Subscription' | 'Commission' | 'Shop Order'. */
  type: string;
  /** Le donateur a accepté l'affichage public de son nom et de son message. */
  isPublic: boolean;
  fromName: string;
  message: string | null;
  isSubscriptionPayment: boolean;
  /** Vrai au tout premier paiement d'un abonnement (les suivants : faux). */
  isFirstSubscriptionPayment: boolean;
}

/** Parse le corps urlencodé d'un webhook Ko-Fi. Null si la forme est invalide. */
export function parseKofi(body: string): KofiPayload | null {
  const data = new URLSearchParams(body).get('data');
  if (!data) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const messageId = j['message_id'];
  if (typeof messageId !== 'string' || !messageId) return null;
  const str = (k: string): string =>
    typeof j[k] === 'string' ? (j[k] as string) : '';
  const msg = j['message'];
  return {
    verificationToken: str('verification_token'),
    messageId,
    timestamp: str('timestamp'),
    type: str('type'),
    isPublic: j['is_public'] === true,
    fromName: str('from_name'),
    message: typeof msg === 'string' ? msg : null,
    isSubscriptionPayment: j['is_subscription_payment'] === true,
    isFirstSubscriptionPayment: j['is_first_subscription_payment'] === true,
  };
}
