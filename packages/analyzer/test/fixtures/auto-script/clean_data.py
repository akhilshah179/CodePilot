import csv
import sys


def clean(rows):
    return [r for r in rows if r.get("email")]


if __name__ == "__main__":
    with open(sys.argv[1]) as f:
        rows = list(csv.DictReader(f))
    print(len(clean(rows)))
