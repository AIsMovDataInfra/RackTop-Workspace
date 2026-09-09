#!/usr/bin/env python3
"""Compatibility entry point: publish one verified Mac and Linux release."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('publish-workspace-update.py')), run_name='__main__')
