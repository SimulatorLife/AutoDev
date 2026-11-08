/**
 * The page-level submit for an auto-submitting select.
 *
 * An auto-submitting select has no submit button: changing it is the
 * submission. That used to be a React `onChange`, which exists only once the
 * page has hydrated -- the Providers page is ~430 KB of markup, and a choice
 * made before hydration finished, or on a page whose script had not loaded,
 * changed what the select showed and sent nothing. The operator saw
 * "Disabled" on Claude's orchestrator role; the Runtime never received it.
 *
 * This listener is installed by an inline script in the root layout, before
 * any component hydrates, and it is the only submit path, before hydration
 * and after: a native form submission until the Console's form owner has
 * mounted, the owner's in-place submission once it has. One path means a
 * change is never submitted twice.
 */

/** The marker an auto-submitting select carries. */
export const SUBMIT_ON_CHANGE_ATTRIBUTE = "data-submit-on-change";

/**
 * Source text of the listener, for an inline `<script>`.
 *
 * Plain ES5 on purpose: it runs before any bundle has loaded, so it can use
 * nothing a bundle would provide.
 */
export const SUBMIT_ON_CHANGE_SCRIPT = `document.addEventListener("change",function(event){var target=event.target;if(!target||target.tagName!=="SELECT"||target.getAttribute("${SUBMIT_ON_CHANGE_ATTRIBUTE}")!=="true"||target.disabled||!target.form)return;target.form.requestSubmit();});`;
