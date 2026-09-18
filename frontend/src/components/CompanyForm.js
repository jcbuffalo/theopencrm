// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useEffect } from 'react';
import api from '../api';
import CustomFieldsSection from './CustomFieldsSection';
import { Alert, Button, Card, Input, Select, Textarea } from './ui';

// Inline create / edit card for a company. Rendered by Companies.js above the
// list (not an overlay) so the user keeps the table in view while editing.

const TYPE_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'vendor',   label: 'Vendor' },
  { value: 'end_user', label: 'End User' },
  { value: 'partner',  label: 'Partner' },
  { value: 'other',    label: 'Other' },
];

const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'prospect', label: 'Prospect' },
];

export default function CompanyForm({ companyId, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    name: '',
    type: 'customer',
    industry: '',
    website: '',
    phone: '',
    location: '',
    employee_count: '',
    annual_revenue: '',
    notes: '',
    status: 'active',
    owner_user_id: '',
    custom_fields: {},
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Record ownership (migration 135): org members feed the owner picker.
  // Personal workspaces (or a failed fetch) get an empty list and the picker
  // simply doesn't render — same graceful pattern as Contacts.js.
  const [members, setMembers] = useState([]);

  useEffect(() => {
    api.get('/org')
      .then((r) => setMembers(r.data?.members || []))
      .catch(() => setMembers([]));
  }, []);

  useEffect(() => {
    if (companyId) {
      fetchCompany();
    }
  }, [companyId]);

  const fetchCompany = async () => {
    try {
      const response = await api.get(`/companies/${companyId}`);
      // Make sure custom_fields is always an object so the section component
      // can spread it without crashing on a legacy row with NULL.
      setFormData({ ...response.data, custom_fields: response.data.custom_fields || {} });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch company');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // owner_user_id must reach the API as an integer or null — the select
      // stores '' for "unassigned" (migration 135 record ownership).
      const payload = {
        ...formData,
        owner_user_id: formData.owner_user_id === '' || formData.owner_user_id == null
          ? null
          : Number(formData.owner_user_id),
      };
      if (companyId) {
        await api.put(`/companies/${companyId}`, payload);
        onSuccess();
      } else {
        // Pass the created record through — a 201 may carry a soft
        // warning.possibleDuplicates the page surfaces as a toast.
        const res = await api.post('/companies', payload);
        onSuccess(res.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save company');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  return (
    <Card title={companyId ? 'Edit company' : 'New company'} className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Company name"
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            required
            placeholder="Acme Corp"
          />

          <Select
            label="Type"
            name="type"
            value={formData.type || 'customer'}
            onChange={handleChange}
            options={TYPE_OPTIONS}
          />

          <Input
            label="Industry"
            type="text"
            name="industry"
            value={formData.industry || ''}
            onChange={handleChange}
            placeholder="Technology"
          />

          <Input
            label="Phone"
            type="tel"
            name="phone"
            value={formData.phone || ''}
            onChange={handleChange}
            placeholder="+1 555 555 5555"
          />

          <Input
            label="Website"
            type="url"
            name="website"
            value={formData.website}
            onChange={handleChange}
            placeholder="https://example.com"
          />

          <Input
            label="Location"
            type="text"
            name="location"
            value={formData.location}
            onChange={handleChange}
            placeholder="San Francisco, CA"
          />

          <Input
            label="Employee count"
            type="number"
            name="employee_count"
            value={formData.employee_count}
            onChange={handleChange}
            placeholder="50"
          />

          <Input
            label="Annual revenue"
            type="text"
            name="annual_revenue"
            value={formData.annual_revenue}
            onChange={handleChange}
            placeholder="$1M"
          />

          <Select
            label="Status"
            name="status"
            value={formData.status}
            onChange={handleChange}
            options={STATUS_OPTIONS}
          />

          {/* Record owner (migration 135) — only renders for org workspaces
              (members list is empty for personal workspaces). */}
          {members.length > 0 && (
            <Select
              label="Owner"
              name="owner_user_id"
              value={formData.owner_user_id ?? ''}
              onChange={handleChange}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.email}</option>
              ))}
            </Select>
          )}
        </div>

        <Textarea
          label="Notes"
          name="notes"
          value={formData.notes}
          onChange={handleChange}
          rows={4}
          placeholder="Additional notes..."
        />

        <CustomFieldsSection
          entity="companies"
          values={formData.custom_fields || {}}
          onChange={(next) => setFormData(prev => ({ ...prev, custom_fields: next }))}
        />

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading} loadingLabel="Saving…">Save company</Button>
        </div>
      </form>
    </Card>
  );
}
