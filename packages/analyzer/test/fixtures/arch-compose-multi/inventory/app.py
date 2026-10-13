from flask import Flask, jsonify

app = Flask(__name__)
STOCK = {"sku-1": 3}


@app.get("/stock/<sku>")
def stock(sku):
    return jsonify({"sku": sku, "available": STOCK.get(sku, 0)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
