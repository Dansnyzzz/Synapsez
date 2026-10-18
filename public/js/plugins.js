/**
 * Plugins: the assistant's built-in tools, in groups a person can switch off.
 *
 * Claude's composer has a Plugins menu (owner, 2026-10-14). Synapsez has no
 * plugins to install, but it does have whole families of tools that a given
 * account may never want — a cloud computer, a cloud browser, office documents —
 * and each one is schema the model is sent on every step. So a plugin here is
 * one of those families: on by default, and off means the model is not given
 * its tools at all (`pluginTools` → `withheldTools` in server/memory.js).
 *
 * One module for both sides, the way tool-aliases.js is: the server withholds
 * by these lists and the menu draws them, so what the menu says is off is what
 * the model does not get.
 *
 * Only tools that stand on their own. Reading the web, files, commands, memory
 * and skills are how the assistant does anything at all, and are not offered
 * for switching off; a connector's tools follow the connector (Connectors).
 */

/** @type {{ id: string, tools: string[] }[]} */
export const PLUGINS = [
  { id: 'office', tools: ['create_file', 'update_file', 'read_generated_file', 'file_versions', 'publish_file', 'export_pdf'] },
  { id: 'visuals', tools: ['chart', 'show_widget', 'show_card', 'generate_image', 'edit_image', 'make_qr'] },
  { id: 'cloud_computer', tools: ['sandbox_run'] },
  { id: 'cloud_browser', tools: ['cloud_browser'] },
  { id: 'research', tools: ['deep_research', 'encyclopedia', 'image_search', 'youtube_transcript', 'read_feed', 'extract'] },
  { id: 'places', tools: ['place_lookup'] },
  { id: 'data', tools: ['market_data', 'world_facts', 'sports', 'analyze_data', 'date_calc', 'convert_units'] },
  { id: 'automation', tools: ['schedule_task', 'list_tasks', 'cancel_task', 'workflow_write', 'workflow_status', 'send_email'] },
];

export const PLUGIN_IDS = new Set(PLUGINS.map((p) => p.id));

/**
 * The tools the switched-off plugins hold, as one set. Unknown ids are ignored,
 * so a plugin removed from this list in a later version cannot hide anything.
 *
 * @param {unknown} off  the account's `pluginsOff`
 * @returns {Set<string>}
 */
export function pluginTools(off) {
  const out = new Set();
  if (!Array.isArray(off)) return out;
  for (const plugin of PLUGINS) if (off.includes(plugin.id)) for (const name of plugin.tools) out.add(name);
  return out;
}
