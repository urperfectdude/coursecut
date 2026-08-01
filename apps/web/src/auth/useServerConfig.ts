// What this deployment can do, read once from `GET /api/config` (M7).
//
// One field today: whether password reset exists. Mail is optional for this
// product — `MAIL_DRIVER` unset is a supported deployment (see
// `apps/api/src/mail.ts`) — and the SPA must not advertise a flow the server
// will refuse. That is the same rule D7 applies to the desktop key UI: remove
// the control rather than ship one that does nothing.
//
// Unauthenticated on purpose, because the screen that needs it is the one
// nobody is signed in on. It reports what the server is configured to do and
// nothing about who is asking.

import { useEffect, useState } from "react";
import { request } from "../api";

export interface ServerConfig {
  password_reset: boolean;
}

const UNKNOWN: ServerConfig = { password_reset: false };

export function useServerConfig(): ServerConfig {
  const [config, setConfig] = useState<ServerConfig>(UNKNOWN);

  useEffect(() => {
    let cancelled = false;
    void request<ServerConfig>("GET", "/config")
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      // A failure here means the API is unreachable, which the sign-in attempt
      // is about to report far better than a config error would. Falling back
      // to "no reset" hides a link rather than showing a broken one.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
