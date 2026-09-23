"""Generate exact arithmetic reference cases independently of the JS recurrence."""
import json
import math
from fractions import Fraction
from pathlib import Path

rows = []
for n in list(range(0, 33)) + [64, 127, 255, 511, 1023]:
    values = range(n + 1) if n <= 32 else sorted({0, 1, n // 2, n // 2 + 1, n - 1, n})
    for b in values:
        numerator = sum(math.comb(n, j) for j in range(b, n + 1))
        fraction = Fraction(numerator, 2**n)
        for alpha in ['0.05', '0.3125', '0.31249999999999994', '1e-300']:
            for family in [1, 10]:
                rows.append({'b': b, 'c': n - b, 'alpha': float(alpha), 'family': family, 'tail': float(fraction), 'reject': fraction <= Fraction(alpha) / family})
output = Path(__file__).resolve().parents[1] / 'fixtures' / 'statistics' / 'exact-tails.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'reference': 'Python math.comb and fractions.Fraction; exact integer summation, decimal alpha', 'cases': rows}, separators=(',', ':')) + '\n')
print(json.dumps({'cases': len(rows), 'output': str(output)}))
