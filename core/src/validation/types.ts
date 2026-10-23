/**
 * One reason a canonical source cannot be applied.
 *
 * `location` names the part of the document at fault in the same terms the
 * operator is looking at -- a server name, a target's override of a server, an
 * event name, an action index, or a source line -- and `message` says what is
 * wrong with it. Neither is a diagnosis of the fix; both are the fact the loader
 * observed and would otherwise have discarded.
 *
 * It lives in its own module because it is shared by every canonical source --
 * the MCP declaration, the hook declaration, the command catalog and the skill
 * catalog each produce one -- and a shared shape is what lets the Control API
 * and the Console validate one form across all of them instead of per resource.
 * It sat in the MCP module while only that module produced one; the hook
 * loader produces one too, and borrowing the MCP module's copy for it would
 * make the hooks depend on the MCPs for a type that is about neither.
 */
export interface RuleSyncValidationIssue {
  readonly location: string;
  readonly message: string;
}
