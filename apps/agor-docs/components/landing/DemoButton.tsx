'use client';

import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { HubSpotMeetingModal } from '../HubSpotMeetingModal';

/** Opens the HubSpot meeting scheduler; the modal is portaled out of its section's styles. */
export function DemoButton({ className, children }: { className?: string; children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setIsOpen(true)}>
        {children}
      </button>
      {isOpen &&
        createPortal(
          <HubSpotMeetingModal isOpen onClose={() => setIsOpen(false)} />,
          document.body
        )}
    </>
  );
}
