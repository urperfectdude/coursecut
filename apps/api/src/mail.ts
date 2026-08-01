// Transactional email (M7) — the plan's last open §4.1 row.
//
// Plan §10 has listed "transactional email provider" as undecided since M3;
// M4 shipped around it (invitations became copyable links) and password reset
// has not existed at all. What was actually blocking was **picking a vendor**,
// not writing the code — so this takes either, and the vendor becomes a
// deployment variable instead of a code decision nobody wanted to make.
//
// Three drivers, chosen by `MAIL_DRIVER`:
//
//   none (default)  Mail is off. `isMailConfigured()` is false, so the API
//                   does not advertise password reset, the SPA does not render
//                   the link, and `better-auth` is configured without a
//                   `sendResetPassword` at all. Nothing half-wired: a reset
//                   form whose mail never arrives is worse than an absent one,
//                   which is the same reasoning D7 applies to the desktop key
//                   UI, and the reason M4 left this out rather than stubbing it.
//   log             Prints the message to the server log. Local development,
//                   where the point is to click the link, not receive it.
//   resend          Real delivery over Resend's HTTP API — one POST, no SDK,
//                   so no dependency to keep current. Postmark and SES are the
//                   same shape; adding one is a branch in `send()`, not a
//                   redesign.
//
// **No email body ever contains transcript text or file contents** (plan §9's
// logging rule, applied to the other place content could escape). What goes
// out is a name, an address the user gave us, and a link.

import { env } from "./env.js";

export interface Message {
  to: string;
  subject: string;
  text: string;
}

/**
 * Whether mail can actually be delivered.
 *
 * The one place that decides whether the password-reset surface exists at all:
 * `auth.ts` reads it to decide whether to configure `sendResetPassword`, and
 * `/api/config` reports it so the SPA renders the "Forgot password?" link only
 * when following it would lead somewhere.
 */
export function isMailConfigured(): boolean {
  const driver = env.mailDriver();
  if (driver === "log") return true;
  if (driver === "resend") return env.mailApiKey().length > 0;
  return false;
}

/**
 * Sends one message, or throws.
 *
 * Throwing matters: `better-auth` surfaces a failed `sendResetPassword` to the
 * caller, so a misconfigured key becomes "we could not send that email" on the
 * screen rather than a silent success and a user waiting for a mail that was
 * never accepted by anyone.
 */
export async function send(message: Message): Promise<void> {
  const driver = env.mailDriver();

  if (driver === "log") {
    console.log(`[mail] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
    return;
  }

  if (driver !== "resend") {
    throw new Error("email is not configured on this server");
  }

  const response = await fetch(env.mailApiUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.mailApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.mailFrom(),
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    // The provider's body can echo the recipient address back; the status is
    // enough to diagnose a bad key or a rejected sender, and it carries no
    // user data into the log.
    throw new Error(`the email provider rejected the message (${response.status})`);
  }
}

/** The reset mail. Plain text on purpose — it is one link, and HTML mail is a
 * deliverability liability for no gain here. */
export function passwordResetMessage(to: string, url: string): Message {
  return {
    to,
    subject: "Reset your CourseCut password",
    text:
      `Someone asked to reset the password for this CourseCut account.\n\n` +
      `${url}\n\n` +
      `If that wasn't you, nothing has changed and you can ignore this message. ` +
      `The link expires in an hour.\n`,
  };
}
