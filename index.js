import { Server } from "socket.io"
import { createServer } from "http"

const users = []

const httpServer = createServer()
const io = new Server( httpServer, {
	cors: {
		origin: "*",
		methods: [ "GET", "POST" ],
	}
} )

httpServer.listen( 80, () => {

	console.log( "Server listening on port 3000" )
} )

io.on( "connection", user => {

	users.push( user )

	user.on( "new_user", user => {

		const geoJSON = {
			type: "Feature",
			properties: {
				username: user.username,
				avatar: user.avatar,
			},
			geometry: {
				type: "Point",
				coordinates: user.coordinates,
			}
		}

		for ( const user of users ) {

			user.emit( "new_user", geoJSON )
		}
	} )

	console.log( "New user..." )
} )
