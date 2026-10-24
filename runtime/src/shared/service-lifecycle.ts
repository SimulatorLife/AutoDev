/**
 * The exit status a supervised service uses to say "not now, try again".
 *
 * `EX_TEMPFAIL` (75) is the sysexits.h status for a temporary failure, and
 * it is the one a service uses when the condition that stopped it may pass
 * on its own -- a backend that has not finished starting, for instance. The
 * Console's launcher verifies the Runtime and Usage contracts before it
 * serves a page, and a backend that is still coming up must not read as a
 * service that can never start.
 *
 * The distinction matters to the supervisor. launchd's KeepAlive restarts a
 * job that exits either way, but a temporary failure is a job that is on its
 * way up, while any other non-zero status is a job that is broken. An
 * installer that cannot tell them apart declares a crash loop on a service
 * that was about to serve.
 *
 * This module is the owner of that status for the Runtime: the platform
 * layer recognizes it, the Runtime's verifiers report it, and the shell
 * launcher passes it through to launchd.
 */
export const SERVICE_TEMPORARY_FAILURE_EXIT_CODE = 75;
