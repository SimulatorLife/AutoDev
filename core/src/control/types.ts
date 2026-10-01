export type ControlApiRole = "viewer" | "operator";

/** Fixed installation identity used by the single-user local Console. */
export const LOCAL_CONTROL_API_ACTOR = "autodev-local";

export interface ControlApiActor {
  readonly actor: string;
  readonly role: ControlApiRole;
}

export interface ControlApiConfig {
  readonly serviceToken: string;
  readonly viewers: ReadonlySet<string>;
  readonly operators: ReadonlySet<string>;
}

export type ControlApiAvailability =
  | { readonly enabled: false; readonly reason: string }
  | { readonly enabled: true; readonly config: ControlApiConfig };

export type ControlApiAuthorization =
  | ({ readonly authorized: true } & ControlApiActor)
  | {
      readonly authorized: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
