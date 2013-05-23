from flask import Flask, render_template, request
import json


############  startup #############
	
app = Flask(__name__)
application = app #WSGI compatibility

@app.route("/")
def index():
	return render_template('index.html')

@app.route("/mobile")
def index_mobile():
	return render_template('index_mobile.html')

if __name__=="__main__":
	app.debug = True
	app.run()


