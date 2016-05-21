"use strict";

module.exports = function(imports) {

	let express = imports.modules.express;
	let ObjectId = imports.modules.mongoose.Types.ObjectId;
	let Promise = imports.modules.Promise;
	let util = imports.util;

	let requireLogin = util.requireLogin;
	let requireLeader = util.requireLeader;
	let requireAdmin = util.requireAdmin;

	let User = imports.models.User;
	let Event = imports.models.Event;
	let AttendanceHandler = imports.models.AttendanceHandler;

	let router = express.Router();

	router.get("/year/:year/month/:month", requireLogin, Promise.coroutine(function*(req, res) {
		let userSubdivisionIds = util.activeSubdivisionIds(req.user.subdivisions);

		let year = req.params.year;
		let month = req.params.month;

		let numberOfDays = new Date(year, month, 0).getDate(); // month is 1 based
		let start = new Date(year, month - 1, 1, 0, 0, 0); // month is 0 based
		let end = new Date(year, month - 1, numberOfDays, 23, 59, 59); // month is 0 based

		try {

			let events = yield Event.find({
				team: req.user.current_team.id,
				$or: [
					{ entireTeam: true },
					{ userAttendees: req.user._id },
					{ subdivisionAttendees: { "$in": userSubdivisionIds } }
				],
				date: {$gte: start, $lte: end}
			});
			
			res.json(events);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.get("/upcoming", requireLogin, Promise.coroutine(function*(req, res) {
		let userSubdivisionIds = util.activeSubdivisionIds(req.user.subdivisions);

		try {

			let events = yield Event.find({
				team: req.user.current_team.id,
				$or: [
					{ entireTeam: true },
					{ userAttendees: req.user._id },
					{ subdivisionAttendees: { "$in": userSubdivisionIds } }
				],
				date: {$gte: new Date()}
			}).sort("date").exec();
			
			res.json(events);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.post("/", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {

		req.body.userAttendees = req.body.userAttendees || [];
		req.body.subdivisionAttendees = req.body.subdivisionAttendees || [];

		req.body.hasAttendance = req.body.hasAttendance == "true";
		req.body.sendEmail = req.body.sendEmail == "true";
		req.body.entireTeam = req.body.entireTeam == "true";

		let event = {
			name: req.body.name,
			date: new Date(req.body.date),
			team: req.user.current_team.id,
			creator: req.user._id,
			hasAttendance: req.body.hasAttendance
		};

		if (req.body.description.length > 0) {
			event.description = req.body.description;
		}

		try {

			let users; // TODO: do not query for users unless either email or attendance is true

			if (req.body.entireTeam) {

				event.entireTeam = true;

				users = yield User.find({
					teams: {$elemMatch: {id: req.user.current_team.id}}
				}, "-password");

			} else {

				event.userAttendees = req.body.userAttendees;
				event.subdivisionAttendees = req.body.subdivisionAttendees;

				users = yield User.find({ $or: [
					{ _id: { $in: req.body.userAttendees } },
					{ subdivisions: { $elemMatch: { "_id": { $in: req.body.subdivisionAttendees } } } }
				] }, "-password");

			}

			event = yield Event.create(event);

			if (req.body.sendEmail) {

				let list = util.createRecepientList(users);

				yield util.sendEmail({
					to: list,
					subject: "New Event on " + util.readableDate(event.date) + " - " + event.name,
					html: req.user.firstname + " " + req.user.lastname + " has created an event on " + util.readableDate(event.date) + ",<br><br>" + event.name + "<br>" + req.body.description
				});

			}

			if (req.body.hasAttendance) {

				let attendees = users.map(attendee => ({
					user: attendee._id,
					status: "absent"
				}));

				yield AttendanceHandler.create({
					event: event._id,
					event_date: event.date,
					attendees: attendees,
					entireTeam: req.body.entireTeam
				});
			}
		
			res.json(event);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.delete("/:eventId", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {
		try {

			yield Event.findOneAndRemove({_id: req.params.eventId});
			
			yield AttendanceHandler.findOneAndRemove({event: req.params.eventId});
			
			res.end("success");

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.get("/:eventId/attendees", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {
		try {

			let handler = yield AttendanceHandler.findOne({event: req.params.eventId}).populate("attendees.user").exec();
			
			res.json(handler.attendees);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.put("/:eventId/attendance", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {
		try {

			yield AttendanceHandler.update({
				event: req.params.eventId
			}, {
				"$set": { attendees: req.body.updatedAttendees }
			});

			res.end("success");

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	function getPresencesAbsences(attendanceHandlers, userId) {
		let absences = [];
		let present = 0;
		for (let handler of attendanceHandlers) {
			for (let attendee of handler.attendees) {
				if (attendee.user == userId) {
					if (attendee.status == "absent") {
						absences.push(handler.event);
					} else if (attendee.status == "present") {
						present++;
					}
					// do nothing if the absense is excused
				}
			}
		}
		return { present: present, absences: absences };
	}

	router.get("/absences", requireLogin, Promise.coroutine(function*(req, res) {
		try {

			let dateConstraints = {};
			if (req.query.startDate) {
				dateConstraints.$gte = new Date(req.query.startDate);
			}
			if (req.query.endDate) {
				dateConstraints.$lte = new Date(req.query.endDate);
			} else {
				dateConstraints.$lte = new Date();
			}

			let handlers = yield AttendanceHandler.find({
				event_date: dateConstraints,
				"attendees.user": req.body.user_id
			}).populate("event").exec();

			let result = getPresencesAbsences(handlers, req.body.user_id);

			res.json(result);

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	router.put("/:eventId/excuseAbsence", requireLogin, requireLeader, Promise.coroutine(function*(req, res) {
		try {

			yield AttendanceHandler.update({
				event : req.params.eventId,
				"attendees.user": req.body.user_id
			}, {
				"$set": {"attendees.$.status": "excused"}
			});
			
			res.end("success");

		} catch (err) {
			console.error(err);
			res.end("fail");
		}
	}));

	return router;

};
