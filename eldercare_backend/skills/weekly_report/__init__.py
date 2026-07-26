import os
import random

_SKILL_DIR = os.path.dirname(os.path.abspath(__file__))


def load_random_template():
    templates = sorted(f for f in os.listdir(_SKILL_DIR) if f.endswith('.md'))
    if not templates:
        raise RuntimeError('周报模板目录为空，请检查 skills/weekly_report/')
    chosen = random.choice(templates)
    path = os.path.join(_SKILL_DIR, chosen)
    with open(path, 'r', encoding='utf-8') as f:
        return chosen, f.read()


def list_templates():
    return sorted(f for f in os.listdir(_SKILL_DIR) if f.endswith('.md'))
