/**
 * The Console's one way to name a control whose visible content is not its name.
 *
 * A control that states its name -- with an `aria-label` or an
 * `aria-labelledby` -- replaces its own content for assistive technology. That
 * is what makes a stated name necessary, and it is also what makes it
 * dangerous: whatever the name leaves out is not merely different from what the
 * screen shows, it is *gone* from it.
 *
 * The target state asks for both halves of such a name. It says what the
 * control points at, and it still contains the text that is visible, so that a
 * voice-control user can say the word they can see and find the control that
 * says it.
 *
 * So the name begins with the word the control shows and then says the rest.
 * The visible word first, because that is the word the operator reads and the
 * one they would say; the detail after it, because that is what the control
 * does.
 *
 * Four places needed it and they were three different shapes:
 *
 *   - the providers' "Docs ↗" link said "Open claude documentation in a new
 *     tab", which does not contain "Docs", while its sibling "Usage ↗"
 *     happened to work only because its name repeated the word;
 *   - the agents' role link showed "browser-tester (Leaf)" and said "Open agent
 *     browser-tester", so the kind was on the page and in nobody's
 *     announcement;
 *   - the workspaces' approval link showed the approval's state -- "Not
 *     approved" -- and said "Open playtesting approval for <workspace>", so
 *     the state was reachable by sight alone;
 *   - the evaluations' target link showed the role and said "Open detail for
 *     evaluation eval-0001", so a page of fifty rows over six roles said which
 *     run it was and not what it was about.
 */
export function namedAfterVisible(visible: string, detail: string): string {
  return `${visible}: ${detail}`;
}
