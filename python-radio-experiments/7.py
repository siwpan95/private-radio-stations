resp = Response(generate_playlist_stream(), mimetype="audio/mpeg")
resp.headers["icy-name"] = "我的Python电台"
resp.headers["icy-br"] = "128"
resp.headers["icy-genre"] = "Various"
return resp