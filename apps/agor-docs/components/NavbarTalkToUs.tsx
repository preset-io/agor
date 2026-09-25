'use client';

import { useState } from 'react';
import { HubSpotMeetingModal } from './HubSpotMeetingModal';

// Navbar "Talk to Us" entry: pops the same HubSpot meeting scheduler modal as
// the Agor Cloud landing page's "Book a demo" button, rather than routing
// anywhere. Rendered as a <Navbar> child beside NavbarCloudCTA; styles.css
// slots it left of the search input via flex order (`.navbar-talk-to-us`) so
// the two CTAs sit together. Hidden on phones, where in-page CTAs carry the flow.
export function NavbarTalkToUs() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button type="button" className="navbar-talk-to-us" onClick={() => setIsOpen(true)}>
        Talk to Us
      </button>
      <HubSpotMeetingModal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Talk to Us" />
    </>
  );
}
