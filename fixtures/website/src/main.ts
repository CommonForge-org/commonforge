import { fetchQuote, type Plan } from "./quote.js";
import { escapeHtml, renderError, renderQuote } from "./quote-view.js";

const apiBase: string = import.meta.env.VITE_QUOTE_API_URL ?? "";

const form = document.querySelector<HTMLFormElement>("#quote-form");
const result = document.querySelector<HTMLElement>("#quote-result");
const footer = document.querySelector<HTMLElement>("#api-version");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!result) return;
  const data = new FormData(form);
  try {
    const quote = await fetchQuote(apiBase, {
      customer: String(data.get("customer") ?? ""),
      plan: String(data.get("plan") ?? "starter") as Plan,
      seats: Number(data.get("seats") ?? 1),
    });
    result.innerHTML = renderQuote(quote);
  } catch (err) {
    result.innerHTML = renderError(err instanceof Error ? err.message : String(err));
  }
});

fetch(`${apiBase.replace(/\/$/, "")}/version`)
  .then((res) => res.json() as Promise<{ name: string; version: string }>)
  .then((v) => {
    if (footer) footer.innerHTML = `${escapeHtml(v.name)} v${escapeHtml(v.version)}`;
  })
  .catch(() => undefined);
