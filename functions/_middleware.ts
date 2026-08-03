/**
 * Link previews for a shared score.
 *
 * The share link carries the score in its query string, but a static page has
 * static Open Graph tags, so every share previewed as the same generic card -
 * and the number, which is the entire reason anyone opens the link, only
 * appeared after they had already opened it. This rewrites the two tags that
 * show in a message bubble, on the way out, leaving the page itself untouched.
 *
 * It runs on every request and must never be the reason one fails: anything
 * without the score parameter, and anything that is not HTML, passes straight
 * through.
 */

interface ScoreShare {
  score: number;
  day: number;
  section: number;
  name: string | null;
}

function readShare(url: URL): ScoreShare | null {
  const score = Number(url.searchParams.get("s"));
  if (!Number.isFinite(score) || score <= 0) return null;
  const day = Number(url.searchParams.get("d"));
  const section = Number(url.searchParams.get("sec"));
  const raw = url.searchParams.get("n");
  // Someone else's name is untrusted text bound for a meta tag: letters,
  // digits and spaces only, and short. HTMLRewriter escapes attribute values,
  // so this is belt and braces rather than the only guard.
  const name = raw ? raw.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 18) : "";
  return {
    score: Math.round(score),
    day: Number.isFinite(day) ? Math.round(day) : 0,
    section: Number.isFinite(section) && section > 0 ? Math.round(section) : 0,
    name: name || null,
  };
}

class MetaRewriter {
  constructor(
    private readonly property: string,
    private readonly value: string,
  ) {}

  element(el: Element): void {
    const key = el.getAttribute("property") ?? el.getAttribute("name");
    if (key === this.property) el.setAttribute("content", this.value);
  }
}

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();
  /*
   * This runs on every request to the site, so it may never be the reason one
   * fails. A preview tag is worth exactly nothing next to the page loading:
   * anything unexpected here hands back the untouched response.
   */
  try {
    return rewrite(context.request, response);
  } catch {
    return response;
  }
};

function rewrite(request: Request, response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return response;

  const share = readShare(new URL(request.url));
  if (!share) return response;

  const who = share.name ?? "Someone";
  const dayPart = share.day > 0 ? ` on day ${share.day}` : "";
  const title = `${who} scored ${share.score.toLocaleString("en-US")} - Daily Escape`;
  const where = share.section > 0 ? `, busted on section ${share.section}` : "";
  const description =
    `${who} got ${share.score.toLocaleString("en-US")}${dayPart}${where}. ` +
    `Everyone drives the same map today - see how far you get.`;

  return new HTMLRewriter()
    .on('meta[property="og:title"]', new MetaRewriter("og:title", title))
    .on('meta[property="og:description"]', new MetaRewriter("og:description", description))
    .on('meta[name="description"]', new MetaRewriter("description", description))
    .on("title", {
      element(el) {
        el.setInnerContent(title);
      },
    })
    .transform(response);
}
