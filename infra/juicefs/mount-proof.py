#!/usr/bin/env python3
"""Run against two independently mounted clients of the same test volume."""
import argparse
import json
import os
from pathlib import Path
import shutil
import time
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('first')
p.add_argument('second')
a = p.parse_args()
name = 'mount-proof-' + str(uuid.uuid4())
first = Path(a.first)/name
second = Path(a.second)/name
first.mkdir()
try:
    start = time.monotonic()
    for i in range(1000):
        (first/str(i)).write_bytes(b'metadata workload\n')
    write_ms = round((time.monotonic()-start)*1000)
    # Permit the documented default metadata-cache interval before discovery.
    deadline = time.monotonic()+10
    while not (second/'999').exists():
        if time.monotonic() > deadline: raise AssertionError('Second client did not see files')
        time.sleep(.1)
    assert (second/'999').read_bytes() == b'metadata workload\n'
    (second/'new').write_text('second client')
    os.rename(second/'new', second/'renamed')
    deadline = time.monotonic()+10
    while not (first/'renamed').exists():
        if time.monotonic() > deadline: raise AssertionError('Rename not visible')
        time.sleep(.1)
    assert (first/'renamed').read_text() == 'second client'
    print(json.dumps({'passed': True, 'files': 1000, 'createMs': write_ms,
                      'checks': ['cross-client read', 'cross-client create', 'atomic rename']}))
finally:
    shutil.rmtree(first)
