// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Input Validators
// Reusable validation and sanitization functions

const validators = {
  /**
   * String validator
   * @param {number} minLen - Minimum length
   * @param {number} maxLen - Maximum length
   * @returns {Function} Validator function
   */
  string: (minLen = 0, maxLen = 255) => (value) => {
    if (!value) return '';
    const trimmed = value.toString().trim();
    if (minLen > 0 && trimmed.length < minLen) {
      throw new Error(`String must be at least ${minLen} characters`);
    }
    return trimmed.substring(0, maxLen);
  },

  /**
   * Integer validator with bounds
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @param {number} defaultVal - Default if invalid
   * @returns {Function} Validator function
   */
  integer: (min = 0, max = 100, defaultVal = 0) => (value) => {
    const num = parseInt(value);
    if (isNaN(num)) return defaultVal;
    return Math.max(min, Math.min(max, num));
  },

  /**
   * Float validator with bounds
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @param {number} decimals - Decimal places
   * @param {number} defaultVal - Default if invalid
   * @returns {Function} Validator function
   */
  float: (min = 0, max = 100, decimals = 2, defaultVal = 0) => (value) => {
    const num = parseFloat(value);
    if (isNaN(num)) return defaultVal;
    const bounded = Math.max(min, Math.min(max, num));
    return parseFloat(bounded.toFixed(decimals));
  },

  /**
   * Boolean validator
   * @param {boolean} defaultVal - Default value
   * @returns {Function} Validator function
   */
  boolean: (defaultVal = false) => (value) => {
    if (value === true || value === 'true' || value === '1' || value === 1) return true;
    if (value === false || value === 'false' || value === '0' || value === 0) return false;
    return defaultVal;
  },

  /**
   * Enum validator - only allow specific values
   * @param {Array} allowedValues - Allowed values
   * @param {*} defaultVal - Default if not in list
   * @returns {Function} Validator function
   */
  enum: (allowedValues, defaultVal) => (value) => {
    return allowedValues.includes(value) ? value : defaultVal;
  },

  /**
   * Email validator
   * @returns {Function} Validator function
   */
  email: () => (value) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!value || !re.test(value)) {
      throw new Error('Invalid email address');
    }
    return value.toLowerCase();
  },

  /**
   * URL validator
   * @returns {Function} Validator function
   */
  url: () => (value) => {
    try {
      new URL(value);
      return value;
    } catch {
      throw new Error('Invalid URL');
    }
  },

  /**
   * Date validator
   * @returns {Function} Validator function
   */
  date: () => (value) => {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
    return date.toISOString();
  },

  /**
   * Slug validator (alphanumeric + hyphens/underscores)
   * @returns {Function} Validator function
   */
  slug: () => (value) => {
    if (!/^[a-z0-9_-]+$/i.test(value)) {
      throw new Error('Slug can only contain letters, numbers, hyphens, and underscores');
    }
    return value.toLowerCase();
  },

  /**
   * Array validator
   * @param {Function} itemValidator - Validator for each item
   * @returns {Function} Validator function
   */
  array: (itemValidator) => (value) => {
    if (!Array.isArray(value)) return [];
    return value.map(itemValidator || (x => x));
  },

  /**
   * Required validator - throw error if empty
   * @returns {Function} Validator function
   */
  required: () => (value) => {
    if (!value) {
      throw new Error('This field is required');
    }
    return value;
  },

  /**
   * Composite validator - chain multiple validators
   * Usage: validators.compose([validators.string(1, 50), validators.required()])
   * @param {Array<Function>} validators - Validator functions to chain
   * @returns {Function} Composite validator
   */
  compose: (...validators) => (value) => {
    return validators.reduce((val, validator) => validator(val), value);
  }
};

module.exports = validators;
