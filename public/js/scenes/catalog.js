/**
 * Every scene: which look it was painted for (`mode`, which never decides the
 * interface's light or dark: the person's own setting does), which part of the
 * picture stays in view on a narrow window (`focus`), and the moment shown when it is
 * not moving (`still`). A scene may ask for a larger canvas, a faster clock, or to be
 * shown smooth rather than as pixels.
 *
 * The same ids as server/themes.js; a test holds the two together.
 *
 * @type {Record<string, { mode: 'light' | 'dark', focus: number[], still: number, width?: number, height?: number, fps?: number, smooth?: boolean, module?: string }>}
 */
export const CATALOG = {
  'cloud-drift': { mode: 'light', focus: [0.5, 0.42], still: 16 },
  'moon-night': { mode: 'dark', focus: [0.55, 0.4], still: 30 },
  lagoon: { mode: 'light', focus: [0.5, 0.5], still: 22 },
  'firefly-grove': { mode: 'dark', focus: [0.5, 0.65], still: 18 },
  'deep-sea': { mode: 'dark', focus: [0.5, 0.42], still: 24 },
  'aurora-peak': { mode: 'dark', focus: [0.5, 0.45], still: 37 },
  'sakura-crossing': { mode: 'light', focus: [0.42, 0.58], still: 14 },
  'rose-street': { mode: 'dark', focus: [0.5, 0.6], still: 21 },
  'nebula-voyage': { mode: 'dark', focus: [0.66, 0.5], still: 12 },
  'rainy-cafe': { mode: 'dark', focus: [0.25, 0.6], still: 15 },
  'golden-harbor': { mode: 'light', focus: [0.16, 0.3], still: 36 },
  'crystal-palace': { mode: 'dark', focus: [0.5, 0.5], still: 44 },
  'new-year-fireworks': { mode: 'dark', focus: [0.5, 0.45], still: 52.6, width: 960, height: 540, fps: 30, smooth: true },
  'snow-village': { mode: 'dark', focus: [0.78, 0.55], still: 12 },
  'tet-spring': { mode: 'light', focus: [0.72, 0.55], still: 12 },
  'phoenix-summer': { mode: 'light', focus: [0.76, 0.5], still: 27 },
  'mid-autumn': { mode: 'dark', focus: [0.72, 0.5], still: 12 },
  'maple-river': { mode: 'light', focus: [0.62, 0.52], still: 47 },
  'golden-horse': { mode: 'light', focus: [0.72, 0.62], still: 27 },
  'goat-terrace': { mode: 'light', focus: [0.8, 0.45], still: 8 },
  // A title's creature, one a title (ranking-panel.js): square, and quicker than a backdrop.
  'pet-minnow': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 20, module: 'pets' },
  'pet-jelly': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 20, module: 'pets' },
  'pet-manta': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 24, module: 'pets' },
  'pet-seadragon': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 24, module: 'pets' },
  'pet-cosmic-whale': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 200, height: 200, fps: 24, module: 'pets' },
  'pet-seahorse': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 20, module: 'pets' },
  'pet-jade-turtle': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 160, height: 160, fps: 24, module: 'pets' },
  'pet-gold-whale': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 200, height: 200, fps: 24, module: 'pets' },
  'pet-bronze-dolphin': { mode: 'dark', focus: [0.5, 0.5], still: 1.4, width: 160, height: 160, fps: 24, module: 'pets' },
  'pet-silver-marlin': { mode: 'dark', focus: [0.5, 0.5], still: 3, width: 180, height: 180, fps: 24, module: 'pets' },
  'pet-koi-dragon': { mode: 'dark', focus: [0.5, 0.5], still: 8, width: 200, height: 200, fps: 24, module: 'pets' },
};
