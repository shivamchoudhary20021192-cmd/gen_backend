import { LookupsRepository } from './lookups.repository';
import type { LookupCategory, LookupValue, LookupValueWithCategory } from './lookups.repository';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export interface LookupCategoryResponse {
  id: number;
  code: string;
  name: string;
  description: string | null;
  allow_custom: boolean;
  sort_order: number;
}

export interface LookupValueResponse {
  id: number;
  code: string;
  label: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  metadata: Record<string, any> | null;
  sort_order: number;
}

export interface LookupValuesGroupedResponse {
  [categoryCode: string]: LookupValueResponse[];
}

// ============================================================================
// SERVICE
// ============================================================================

export class LookupsService {
  /**
   * Get all active lookup categories
   */
  static async getCategories(): Promise<LookupCategoryResponse[]> {
    const categories = await LookupsRepository.getCategories();
    return categories.map(this.mapCategoryToResponse);
  }

  /**
   * Get lookup values by category code
   */
  static async getValuesByCategory(categoryCode: string): Promise<LookupValueResponse[]> {
    const values = await LookupsRepository.getValuesByCategory(categoryCode);
    return values.map(this.mapValueToResponse);
  }

  /**
   * Get all lookup values grouped by category
   * Useful for loading all dropdowns at once
   */
  static async getAllValuesGrouped(): Promise<LookupValuesGroupedResponse> {
    const values = await LookupsRepository.getAllValues();

    const grouped: LookupValuesGroupedResponse = {};

    for (const value of values) {
      const categoryCode = value.category_code;
      if (!grouped[categoryCode]) {
        grouped[categoryCode] = [];
      }
      grouped[categoryCode].push(this.mapValueToResponse(value));
    }

    return grouped;
  }

  /**
   * Get multiple categories with their values
   * Example: ['benefits', 'skin_types', 'skin_concerns']
   */
  static async getMultipleCategoriesWithValues(
    categoryCodes: string[],
  ): Promise<LookupValuesGroupedResponse> {
    const valuesMap = await LookupsRepository.getMultipleCategoriesWithValues(categoryCodes);

    const result: LookupValuesGroupedResponse = {};
    for (const [categoryCode, values] of Object.entries(valuesMap)) {
      result[categoryCode] = values.map(this.mapValueToResponse);
    }

    return result;
  }

  /**
   * Search lookup values
   */
  static async searchValues(
    query: string,
    categoryCode?: string,
  ): Promise<LookupValueWithCategory[]> {
    return LookupsRepository.searchValues(query, categoryCode);
  }

  // ============================================================================
  // ADMIN OPERATIONS
  // ============================================================================

  /**
   * Create a new lookup category
   */
  static async createCategory(data: {
    code: string;
    name: string;
    description?: string;
    allow_custom?: boolean;
    sort_order?: number;
  }): Promise<number> {
    return LookupsRepository.createCategory(data);
  }

  /**
   * Update a lookup category
   */
  static async updateCategory(
    id: number,
    data: {
      name?: string;
      description?: string;
      allow_custom?: boolean;
      is_active?: boolean;
      sort_order?: number;
    },
  ): Promise<void> {
    return LookupsRepository.updateCategory(id, data);
  }

  /**
   * Create a new lookup value
   */
  static async createValue(data: {
    category_id: number;
    code: string;
    label: string;
    description?: string;
    icon?: string;
    color?: string;
    metadata?: Record<string, any>;
    sort_order?: number;
  }): Promise<number> {
    return LookupsRepository.createValue(data);
  }

  /**
   * Update a lookup value
   */
  static async updateValue(
    id: number,
    data: {
      label?: string;
      description?: string;
      icon?: string;
      color?: string;
      metadata?: Record<string, any>;
      is_active?: boolean;
      sort_order?: number;
    },
  ): Promise<void> {
    return LookupsRepository.updateValue(id, data);
  }

  /**
   * Delete a lookup value
   */
  static async deleteValue(id: number): Promise<void> {
    return LookupsRepository.deleteValue(id);
  }

  /**
   * Reorder lookup values
   */
  static async reorderValues(categoryId: number, orderedIds: number[]): Promise<void> {
    return LookupsRepository.reorderValues(categoryId, orderedIds);
  }

  // ============================================================================
  // MAPPERS
  // ============================================================================

  private static mapCategoryToResponse(category: LookupCategory): LookupCategoryResponse {
    return {
      id: category.id,
      code: category.code,
      name: category.name,
      description: category.description,
      allow_custom: category.allow_custom,
      sort_order: category.sort_order,
    };
  }

  private static mapValueToResponse(value: LookupValue): LookupValueResponse {
    return {
      id: value.id,
      code: value.code,
      label: value.label,
      description: value.description,
      icon: value.icon,
      color: value.color,
      metadata: value.metadata,
      sort_order: value.sort_order,
    };
  }
}
