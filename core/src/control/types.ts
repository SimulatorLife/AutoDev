export type ControlApiRole = "viewer" | "operator";

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
