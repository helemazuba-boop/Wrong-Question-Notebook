#!/usr/bin/env python3
"""Reject empty, skipped or failing test reports."""
import pathlib
import sys
import xml.etree.ElementTree as ET

directory, minimum = pathlib.Path(sys.argv[1]), int(sys.argv[2])
cases = [case for file in directory.rglob('*.xml') for case in ET.parse(file).getroot().iter('testcase')]
if len(cases) < minimum:
    sys.exit(f'Expected at least {minimum} executed tests, found {len(cases)}')
if any(case.find(tag) is not None for case in cases for tag in ('skipped', 'failure', 'error')):
    sys.exit('Test report contains skipped or failing tests')
print(f'Verified {len(cases)} executed, passing tests')
