/**
 * What the mask caught, on the day it was measured: the figures the Settings page shows.
 *
 * Written by hand from test/deidentify-corpus.test.mjs, which fails the moment these stop
 * being what it measures, so the page cannot quietly go stale. They come from samples
 * written for the purpose, hard cases included, and say nothing about anybody's real text.
 */
export const MEASURED = Object.freeze({
  date: '2026-11-06',
  samples: 121,
  clean: 29,
  kinds: {
    ACCOUNT: { samples: 5, recall: 1, precision: 1 },
    ADDRESS: { samples: 10, recall: 0.7, precision: 1 },
    BIRTHDATE: { samples: 7, recall: 0.857, precision: 1 },
    CARD: { samples: 4, recall: 1, precision: 1 },
    EMAIL: { samples: 7, recall: 0.857, precision: 1 },
    ID: { samples: 13, recall: 0.923, precision: 1 },
    IP: { samples: 5, recall: 0.8, precision: 0.8 },
    PERSON: { samples: 17, recall: 0.824, precision: 1 },
    PHONE: { samples: 12, recall: 1, precision: 1 },
    PLATE: { samples: 5, recall: 0.8, precision: 0.8 },
    SECRET: { samples: 10, recall: 1, precision: 1 },
  },
});
