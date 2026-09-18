// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useEffect } from 'react';
import api from '../api';
import CustomFieldsSection from './CustomFieldsSection';
import { Alert, Button, Card, Input, Select } from './ui';

// Inline create / edit card for a contact. Rendered by Contacts.js above the
// list (not an overlay) so the user keeps the table in view while editing.

const STATUS_OPTIONS = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'lead',     label: 'Lead' },
  { value: 'customer', label: 'Customer' },
  { value: 'inactive', label: 'Inactive' },
];

export default function ContactForm({ contactId, onClose, onSuccess, onTierLimit }) {
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    job_title: '',
    company_id: '',
    status: 'prospect',
    custom_fields: {},
  });
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchCompanies();
    if (contactId) {
      fetchContact();
    }
  }, [contactId]);

  const fetchCompanies = async () => {
    try {
      const response = await api.get('/companies');
      setCompanies(response.data);
    } catch (err) {
      console.error('Failed to fetch companies:', err);
    }
  };

  const fetchContact = async () => {
    try {
      const response = await api.get(`/contacts/${contactId}`);
      setFormData({ ...response.data, custom_fields: response.data.custom_fields || {} });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch contact');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (contactId) {
        await api.put(`/contacts/${contactId}`, formData);
        onSuccess();
      } else {
        // Pass the created record through — a 201 may carry a soft
        // warning.possibleDuplicates the page surfaces as a toast.
        const res = await api.post('/contacts', formData);
        onSuccess(res.data);
      }
    } catch (err) {
      // Tier-cap 402 → let the page show the non-blocking upgrade nudge; the
      // inline message still renders (it carries the upgrade text).
      if (err.response?.status === 402 && err.response?.data?.code === 'TIER_LIMIT_EXCEEDED' && onTierLimit) {
        onTierLimit(err.response.data);
      }
      setError(err.response?.data?.error || 'Failed to save contact');
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
    <Card title={contactId ? 'Edit contact' : 'New contact'} className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="First name"
            type="text"
            name="first_name"
            value={formData.first_name}
            onChange={handleChange}
            required
            placeholder="John"
          />

          <Input
            label="Last name"
            type="text"
            name="last_name"
            value={formData.last_name}
            onChange={handleChange}
            required
            placeholder="Doe"
          />

          <Input
            label="Email"
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="john@example.com"
          />

          <Input
            label="Phone"
            type="tel"
            name="phone"
            value={formData.phone}
            onChange={handleChange}
            placeholder="+1 (555) 123-4567"
          />

          <Input
            label="Job title"
            type="text"
            name="job_title"
            value={formData.job_title}
            onChange={handleChange}
            placeholder="VP of Sales"
          />

          <Select
            label="Company"
            name="company_id"
            value={formData.company_id}
            onChange={handleChange}
          >
            <option value="">Select a company...</option>
            {companies.map(company => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Select>

          <Select
            label="Status"
            name="status"
            value={formData.status}
            onChange={handleChange}
            options={STATUS_OPTIONS}
          />
        </div>

        <CustomFieldsSection
          entity="contacts"
          values={formData.custom_fields || {}}
          onChange={(next) => setFormData(prev => ({ ...prev, custom_fields: next }))}
        />

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading} loadingLabel="Saving…">Save contact</Button>
        </div>
      </form>
    </Card>
  );
}
