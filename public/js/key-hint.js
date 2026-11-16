import { t } from './i18n.js';

/** A key hint that holds two shapes ("AIza… or AQ.…"), with its "or" in the reader's language. */
export const hintText = (hint) => String(hint || '').split(' or ').join(` ${t('keys.hintOr')} `);
