"""Regenerate browser fixtures from the synthetic Python dataset."""
from dataclasses import asdict
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.sample_data import sample_comments

if __name__ == '__main__':
    data = json.dumps([asdict(comment) for comment in sample_comments()], ensure_ascii=False, indent=2)
    target = ROOT / 'web' / 'sample-data.js'
    target.write_text('"use strict";\n\n// Synthetic comments; generated from src/sample_data.py.\n'
                      + 'globalThis.ReviewDemoData = Object.freeze(' + data + '.map(Object.freeze));\n', encoding='utf-8')
    print('Updated web/sample-data.js with 72 synthetic comments.')
