// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { Modal, Tabs, PageHeader, Input, Menu, Button, Alert, StatusBadge, EmptyState } from './index';

describe('Modal', () => {
  it('renders nothing when closed and a dialog when open', () => {
    const { rerender } = render(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<Modal open onClose={() => {}} title="Hi">body</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes on Escape and on backdrop click, but not on panel click', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="T"><button>inner</button></Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the panel and traps Tab', async () => {
    render(
      <Modal open onClose={() => {}} title="Trap" footer={<button>Last</button>}>
        <button>First</button>
      </Modal>
    );
    // Initial focus lands on the first focusable (the header close button).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Close')));
    const last = screen.getByText('Last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('restores body scroll when unmounted', () => {
    const { unmount } = render(<Modal open onClose={() => {}} title="T">x</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Tabs', () => {
  const items = [
    { id: 'a', label: 'Alpha', count: 2 },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma', disabled: true },
    { id: 'd', label: 'Delta' },
  ];

  function Harness() {
    const [v, setV] = useState('a');
    return <Tabs items={items} value={v} onChange={setV} aria-label="Demo" />;
  }

  it('marks the active tab and shows counts', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('moves and selects with arrow keys, skipping disabled tabs and wrapping', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: /Alpha/ });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    const beta = screen.getByRole('tab', { name: /Beta/ });
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta, { key: 'ArrowRight' }); // Gamma disabled → Delta
    expect(screen.getByRole('tab', { name: /Delta/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: /Delta/ }), { key: 'ArrowRight' }); // wrap
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(screen.getByRole('tab', { name: /Delta/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('PageHeader', () => {
  it('renders an h1, exactly one primary action, and demotes utilities into a menu', () => {
    const onNew = vi.fn();
    const onExport = vi.fn();
    render(
      <MemoryRouter>
        <PageHeader
          title="Companies"
          subtitle="sub"
          primaryAction={{ label: 'New company', onClick: onNew }}
          secondaryActions={[
            { label: 'Import CSV', icon: 'upload', onClick: () => {} },
            { label: 'Export CSV', icon: 'download', onClick: onExport },
          ]}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Companies' })).toBeInTheDocument();
    const primaries = document.querySelectorAll('button.bg-brand-blue');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent('New company');
    // Utilities are not visible buttons until the overflow menu opens.
    expect(screen.queryByText('Export CSV')).toBeNull();
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Export CSV/ }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders without any actions', () => {
    render(<PageHeader title="Plain" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Plain');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Input', () => {
  it('wires label, hint and error state', () => {
    const { rerender } = render(<Input label="Email" hint="We never share it" value="" onChange={() => {}} />);
    const input = screen.getByLabelText('Email');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('-hint'));
    rerender(<Input label="Email" error="Required" value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
    expect(screen.getByLabelText('Email').className).toContain('border-danger-400');
  });
});

describe('Menu / Alert / StatusBadge / EmptyState', () => {
  it('Menu closes on Escape', () => {
    render(<Menu items={[{ label: 'One', onClick: () => {} }]} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Alert uses role=alert for danger and role=status for info, and can be dismissed', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Alert tone="danger" onDismiss={onDismiss}>Boom</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalled();
    rerender(<Alert tone="info">FYI</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('FYI');
  });

  it('StatusBadge accepts the danger alias and Button renders icons', () => {
    render(<><StatusBadge tone="danger" label="Halted" /><Button icon="plus">Add</Button></>);
    expect(screen.getByText('Halted').className).toContain('bg-danger-100');
    expect(document.querySelector('svg[data-icon="plus"]')).toBeInTheDocument();
  });

  it('EmptyState renders an Icon for known names and raw glyphs otherwise', () => {
    const { rerender } = render(<EmptyState icon="building" title="Empty" />);
    expect(document.querySelector('svg[data-icon="building"]')).toBeInTheDocument();
    rerender(<EmptyState icon="✅" title="Empty" />);
    expect(screen.getByText('✅')).toBeInTheDocument();
  });
});
