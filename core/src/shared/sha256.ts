/**
 * The one owner of "this string is a sha256 digest".
 *
 * The Runtime, the Data layer and the Console all read digests out of the
 * artifacts they exchange: a content hash, an evidence hash, a build digest.
 * Each side used to spell the shape of a digest for itself, and a copy that
 * disagreed with another -- one accepting a shorter digest, another refusing
 * an uppercase one -- would have been found only by the artifact that failed
 * to load.
 *
 * The shape is a hex digest of exactly 64 characters, in either case. The
 * digests these systems exchange are computed by Node's crypto, which writes
 * them lowercase, but a digest that arrived uppercase names the same bytes,
 * and refusing it would reject a value that is not wrong.
 *
 * This is the digest of a file or a payload. A git commit or a build
 * reference is a different thing and carries its own shape.
 */
export const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
