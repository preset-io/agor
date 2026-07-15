'use client';

import { useState } from 'react';
import { HubSpotFormModal } from './HubSpotFormModal';

// Navbar "Agor Cloud" entry — pops the beta-signup modal (same flow as the
// landing-page CTAs) instead of navigating. Rendered as <Navbar> children;
// styles.css slots it left of the search input via flex order.
export function NavbarCloudCTA() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button type="button" className="navbar-cloud-cta" onClick={() => setIsOpen(true)}>
        Agor Cloud
      </button>
      <HubSpotFormModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
