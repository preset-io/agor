import type { BoardObject } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ZoneConfigModal } from './ZoneConfigModal';

const zoneData = (label: string): BoardObject => ({
  type: 'zone',
  x: 0,
  y: 0,
  width: 400,
  height: 600,
  label,
});

describe('ZoneConfigModal', () => {
  it('does not reset in-progress edits during parent rerenders while open', () => {
    const { rerender } = render(
      <ZoneConfigModal
        open
        onCancel={() => {}}
        zoneName="Zone"
        objectId="zone-1"
        onUpdate={() => {}}
        zoneData={zoneData('Zone')}
      />
    );

    const nameInput = screen.getByLabelText('Zone Name');
    fireEvent.change(nameInput, { target: { value: 'Draft name' } });

    rerender(
      <ZoneConfigModal
        open
        onCancel={() => {}}
        zoneName="Zone"
        objectId="zone-1"
        onUpdate={() => {}}
        zoneData={zoneData('Zone')}
      />
    );

    expect(nameInput).toHaveValue('Draft name');
  });
});
