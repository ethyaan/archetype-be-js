import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';

import modules from './modules/index.js';
import { handleError } from './common/index.js';

const app = express();
app._E = handleError;

app.use(express.json());
app.use(cors({
	'allowedHeaders': ['Content-Type', 'Authorization'],
	'exposedHeaders': ['Content-Type', 'Authorization'],
	credentials: true,
	methods: 'GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE',
	// origin: `*`,
	// preflightContinue: false
}));

app.get('/health', (request, response) => {
	return response.send('healthy');
});

// options for the swagger docs
const options = {
	//swaggerDefinitions
	definition: {
		openapi: "3.0.3",
		info: {
			title: 'REST API for Archetype NEMBBMS',
			version: '0.1.0',
			description: 'The REST API specification for Archetype NEMBBMS',
		}
	},
	// path to the API docs
	apis: ['./modules/**/*.yaml'],
};
// initialize swagger-jsdoc
const swaggerSpec = swaggerJSDoc(options);
// use swagger-Ui-express for your app documentation endpoint
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

modules(app);

export default app;
