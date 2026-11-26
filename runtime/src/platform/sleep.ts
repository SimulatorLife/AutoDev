/** Shared platform dependency seam; use Node's native promise-based timer. */
export { setTimeout as sleep } from "node:timers/promises";
