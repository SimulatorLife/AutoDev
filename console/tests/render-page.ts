import { Writable } from "node:stream";
import type React from "react";
import { renderToPipeableStream } from "react-dom/server";

/**
 * Render a page element the way the server renders it: the shell first, and
 * then the content that replaces the page's pending placeholder.
 *
 * `renderToStaticMarkup` cannot do this. A page's own content lives below the
 * page's pending boundary, so a static render stops at the boundary's
 * fallback and never reaches the content the page is about -- and the content
 * is the part a page test is about.
 */
export async function renderPageMarkup(element: React.ReactElement): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk as Buffer));
        callback();
      },
      final(callback) {
        callback();
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    const { pipe } = renderToPipeableStream(element, {
      onError(error: unknown) {
        reject(error);
      },
      onShellError(error: unknown) {
        reject(error);
      }
    });
    pipe(sink);
  });
}
