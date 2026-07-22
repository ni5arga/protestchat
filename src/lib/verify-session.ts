/**
 * Proof that the verify screen for a given contact was opened from the
 * in-app "Verify" action in chat, not from an incoming deep link, QR-driven
 * intent, or another app.
 *
 * A URL cannot carry this proof: whatever a link puts in `/verify/<id>` is
 * exactly the same param the in-app button would have produced, so origin
 * has to be something a link literally cannot set. This is an in-memory,
 * single-use flag armed by the trusted button press and consumed the moment
 * the screen mounts. It is never persisted and never derived from anything
 * external, so a `protestchat://verify/<id>` link always arrives unarmed.
 */

const armed = new Map<string, number>();

// Generous enough to survive the push/mount tick without ever making sense
// as a window an attacker could race into from outside the app.
const ARM_WINDOW_MS = 5 * 60 * 1000;

export function armVerification(publicId: string, now = Date.now()): void {
  armed.set(publicId, now);
}

export function consumeVerificationArm(publicId: string, now = Date.now()): boolean {
  const at = armed.get(publicId);
  armed.delete(publicId);
  return at !== undefined && now - at <= ARM_WINDOW_MS;
}
