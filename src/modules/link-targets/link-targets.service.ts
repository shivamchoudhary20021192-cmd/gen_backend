import { ApiError } from '../../core/ApiError';
import {
  LINK_TARGET_TYPES,
  linkTargetsRepository,
  type LinkTargetRow,
  type LinkTargetType,
} from './link-targets.repository';

/** How many suggestions a picker shows before asking for a narrower search. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

function present(row: LinkTargetRow) {
  return {
    id: Number(row.id),
    label: row.label,
    hint: row.hint,
    /**
     * Why this target would not work if it were chosen.
     *
     * Deliberately not an error: a merchandiser may well be building a banner
     * for a product that goes live on Friday, and refusing the choice would send
     * them back to typing ids. Saying so on the row is enough — what is wrong is
     * choosing a draft *without knowing*.
     */
    warning: row.warning,
  };
}

function parseType(raw: unknown): LinkTargetType {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const match = LINK_TARGET_TYPES.find((type) => type === value);
  if (!match) {
    throw ApiError.badRequest(
      `Nothing to search for a "${value || 'missing'}" link. Searchable kinds: ${LINK_TARGET_TYPES.join(', ')}.`,
    );
  }
  return match;
}

export const linkTargetsService = {
  /** The kinds a picker may offer, so the admin does not hard-code the list. */
  types(): readonly LinkTargetType[] {
    return LINK_TARGET_TYPES;
  },

  async search(params: Record<string, unknown>) {
    const type = parseType(params.type);
    const term = typeof params.q === 'string' ? params.q.trim().slice(0, 80) : '';
    const requested = Number(params.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const rows = await linkTargetsRepository.search(type, term, limit);
    return {
      type,
      targets: rows.map(present),
      /**
       * Whether the list was cut short.
       *
       * The picker says so rather than pretending these are all the matches —
       * a merchandiser scrolling a list of 25 out of 400 and concluding their
       * product does not exist is the failure this whole endpoint is avoiding.
       */
      truncated: rows.length === limit,
    };
  },

  /** What a saved id actually is, so a form never opens showing a bare number. */
  async resolve(params: Record<string, unknown>) {
    const type = parseType(params.type);
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('A link target id must be a positive number.');

    const row = await linkTargetsRepository.byId(type, id);
    // Null rather than a 404: a banner pointing at something since deleted is a
    // real state the form has to render, and it should say "#42 — no longer
    // exists" rather than fail to load.
    return { type, target: row ? present(row) : null };
  },
};
