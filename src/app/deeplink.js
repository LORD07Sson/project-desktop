
import { toast } from "./api.js";
import { openReportDetail } from "./report-detail.js";
import { parseProjectLink, parseLuaToolsLink, reportLink } from "./deeplink-core.js";

export function openProjectLink(url) {
  const link = parseProjectLink(url);
  if (link) { openReportDetail(link.id); return true; }

  const lt = parseLuaToolsLink(url);
  if (lt) { openLuaToolsLink(lt); return true; }

  return false;
}

async function openLuaToolsLink(lt) {
  const { switchTab, tabAllowed } = await import("./tabs.js");
  if (!tabAllowed("luatools")) { toast("LuaProject недоступен: нет права в вашей роли.", "error"); return; }
  switchTab("luatools");
  await new Promise(r => setTimeout(r, 100));
  const { openDetailFromDeepLink } = await import("./luatools.js");
  if (typeof openDetailFromDeepLink === "function") openDetailFromDeepLink(lt.appId, lt.kind);
}

document.addEventListener("click", async e => {
  const open = e.target.closest("[data-plink]");
  if (open) { e.preventDefault(); openProjectLink(open.dataset.plink); return; }
  const copy = e.target.closest("[data-copy-plink]");
  if (copy) {
    e.preventDefault();
    try { await navigator.clipboard.writeText(reportLink(copy.dataset.copyPlink)); toast("Ссылка скопирована.", "success"); }
    catch (_) { toast("Не удалось скопировать.", "error"); }
  }
});
