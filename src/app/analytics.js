
import { $ } from "./utils.js";
import { mountPulse } from "./pulse-tab.js";

export async function loadAnalytics() {
  mountPulse($("#analytics-body"));
}
