// Google Ads lead conversion, fired from the audit island once the submit is
// accepted. Enhanced conversions: the email and phone go to gtag as user_data
// (gtag hashes them before sending) so Google can match the lead to the click.
import { tracking } from '../config/tracking';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// US numbers to E.164; anything else is left out rather than sent malformed.
function toE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// Suppressed for local dev and QA walks (?qa=1) so automated runs never
// pollute conversion counts. transaction_id (the job id) dedupes a repeat fire.
export function fireLeadConversion(lead: { email: string; phone: string; jobId: string }): void {
  const { tagId, conversionLabel } = tracking.googleAds;
  if (!tagId || !conversionLabel) return;
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  const { hostname, search } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return;
  if (new URLSearchParams(search).has('qa')) return;

  const userData: Record<string, string> = { email: lead.email.trim().toLowerCase() };
  const phone = toE164(lead.phone);
  if (phone) userData.phone_number = phone;

  window.gtag('set', 'user_data', userData);
  window.gtag('event', 'conversion', {
    send_to: `${tagId}/${conversionLabel}`,
    transaction_id: lead.jobId,
  });
}
