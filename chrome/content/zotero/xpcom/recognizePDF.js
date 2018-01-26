/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2018 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

Zotero.RecognizePDF = new function () {
	const OFFLINE_RECHECK_DELAY = 60 * 1000;
	const MAX_PAGES = 5;
	
	this.ROW_QUEUED = 1;
	this.ROW_PROCESSING = 2;
	this.ROW_FAILED = 3;
	this.ROW_SUCCEEDED = 4;
	
	let _listeners = {};
	let _rows = [];
	let _queue = [];
	let _queueProcessing = false;
	
	/**
	 * Add listener
	 * @param name Event name
	 * @param callback
	 */
	this.addListener = function (name, callback) {
		_listeners[name] = callback;
	};
	
	/**
	 * Remove listener
	 * @param name Event name
	 */
	this.removeListener = function (name) {
		delete _listeners[name];
	};
	
	/**
	 * Checks whether a given PDF could theoretically be recognized
	 * @param {Zotero.Item} item
	 * @return {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	this.canRecognize = function (item) {
		return item.attachmentContentType
			&& item.attachmentContentType === 'application/pdf'
			&& item.isTopLevelItem();
	};
	
	/**
	 * Adds items to the queue and starts processing it
	 * @param items {Zotero.Item}
	 */
	this.recognizeItems = function (items) {
		for (let item of items) {
			_addItem(item);
		}
		_processQueue();
	};
	
	/**
	 * Returns all rows
	 * @return {Array}
	 */
	this.getRows = function () {
		return _rows;
	};
	
	/**
	 * Returns rows count
	 * @return {Number}
	 */
	this.getTotal = function () {
		return _rows.length;
	};
	
	/**
	 * Returns processed rows count
	 * @return {Number}
	 */
	this.getProcessedTotal = function () {
		return _rows.filter(row => row.status > Zotero.RecognizePDF.ROW_PROCESSING).length;
	};
	
	/**
	 * Stop processing items
	 */
	this.cancel = function () {
		_queue = [];
		_rows = [];
		if (_listeners['empty']) {
			_listeners['empty']();
		}
	};
	
	/**
	 * Add item for processing
	 * @param item
	 * @return {null}
	 */
	function _addItem(item) {
		for (let row of _rows) {
			if (row.id === item.id) {
				if (row.status > Zotero.RecognizePDF.ROW_PROCESSING) {
					_deleteRow(row.id);
					break;
				}
				return null;
			}
		}
		
		let row = {
			id: item.id,
			status: Zotero.RecognizePDF.ROW_QUEUED,
			fileName: item.getField('title'),
			message: ''
		};
		
		_rows.unshift(row);
		_queue.unshift(item.id);
		
		if (_listeners['rowadded']) {
			_listeners['rowadded'](row);
		}
		
		if (_listeners['nonempty'] && _rows.length === 1) {
			_listeners['nonempty']();
		}
	}
	
	/**
	 * Update row status and message
	 * @param itemID
	 * @param status
	 * @param message
	 */
	function _updateRow(itemID, status, message) {
		for (let row of _rows) {
			if (row.id === itemID) {
				row.status = status;
				row.message = message;
				if (_listeners['rowupdated']) {
					_listeners['rowupdated']({
						id: row.id,
						status,
						message: message || ''
					});
				}
				return;
			}
		}
	}
	
	/**
	 * Delete row
	 * @param itemID
	 */
	function _deleteRow(itemID) {
		for (let i = 0; i < _rows.length; i++) {
			let row = _rows[i];
			if (row.id === itemID) {
				_rows.splice(i, 1);
				if (_listeners['rowdeleted']) {
					_listeners['rowdeleted']({
						id: row.id
					});
				}
				return;
			}
		}
	}
	
	/**
	 * Triggers queue processing and returns when all items in the queue are processed
	 * @return {Promise}
	 */
	async function _processQueue() {
		await Zotero.Schema.schemaUpdatePromise;
		
		if (_queueProcessing) return;
		_queueProcessing = true;
		
		while (1) {
			if (Zotero.HTTP.browserIsOffline()) {
				await Zotero.Promise.delay(OFFLINE_RECHECK_DELAY);
				continue;
			}
			
			let itemID = _queue.shift();
			if (!itemID) break;
			
			_updateRow(itemID, Zotero.RecognizePDF.ROW_PROCESSING, Zotero.getString('recognizePDF.processing'));
			
			try {
				let newItem = await _processItem(itemID);
				
				if (newItem) {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_SUCCEEDED, newItem.getField('title'));
				}
				else {
					_updateRow(itemID, Zotero.RecognizePDF.ROW_FAILED, Zotero.getString('recognizePDF.noMatches'));
				}
			}
			catch (e) {
				Zotero.logError(e);
				
				_updateRow(
					itemID,
					Zotero.RecognizePDF.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString('recognizePDF.error')
				);
			}
		}
		
		_queueProcessing = false;
	}
	
	/**
	 * Processes the item and places it as a children of the new item
	 * @param itemID
	 * @return {Promise}
	 */
	async function _processItem(itemID) {
		let item = await Zotero.Items.getAsync(itemID);
		
		if (!item || item.parentItemID) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');
		
		let newItem = await _recognize(item);
		
		if (newItem) {
			// put new item in same collections as the old one
			let itemCollections = item.getCollections();
			await Zotero.DB.executeTransaction(async function () {
				for (let itemCollection of itemCollections) {
					let collection = Zotero.Collections.get(itemCollection);
					await collection.addItem(newItem.id);
				}
				
				// put old item as a child of the new item
				item.parentID = newItem.id;
				await item.save();
			});
			
			return newItem
		}
		
		return null;
	}
	
	/**
	 * Get json from a PDF
	 * @param {String} filePath PDF file path
	 * @param {Number} pages Number of pages to extract
	 * @return {Promise}
	 */
	async function extractJSON(filePath, pages) {
		let cacheFile = Zotero.File.pathToFile(Zotero.getTempDirectory().path);
		cacheFile.append("recognizePDFcache.txt");
		if (cacheFile.exists()) {
			cacheFile.remove(false);
		}
		
		let {exec, args} = Zotero.Fulltext.getPDFConverterExecAndArgs();
		args.push('-json', '-l', pages, filePath, cacheFile.path);
		
		Zotero.debug("RecognizePDF: Running " + exec.path + " " + args.map(arg => "'" + arg + "'").join(" "));
		
		try {
			await Zotero.Utilities.Internal.exec(exec, args);
			let content = await Zotero.File.getContentsAsync(cacheFile.path);
			cacheFile.remove(false);
			return JSON.parse(content);
		}
		catch (e) {
			Zotero.logError(e);
			cacheFile.remove(false);
			throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
		}
	}
	
	/**
	 * Attach appropriate handlers to a Zotero.Translate instance and begin translation
	 * @return {Promise}
	 */
	async function _promiseTranslate(translate, libraryID) {
		translate.setHandler('select', function (translate, items, callback) {
			for (let i in items) {
				let obj = {};
				obj[i] = items[i];
				callback(obj);
				return;
			}
		});
		
		let newItems = await translate.translate({
			libraryID,
			saveAttachments: false
		});
		if (newItems.length) {
			return newItems[0];
		}
		throw new Error('No items found');
	}
	
	async function _query(json) {
		let uri = 'http://62.210.116.165:8003/recognize';
		
		let client = Zotero.Sync.Runner.getAPIClient();
		
		try {
			let req = await client.makeRequest(
				'POST',
				uri,
				{
					successCodes: [200],
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(json),
					noAPIKey: true
				}
			);
			return JSON.parse(req.responseText);
		}
		catch (e) {
			Zotero.logError(e);
			throw new Error("Request error");
		}
	}
	
	/**
	 * Retrieves metadata for a PDF and saves it as an item
	 * @param {Zotero.Item} item
	 * @return {Promise}
	 */
	async function _recognize(item) {
		let filePath = await item.getFilePath();
		let json = await extractJSON(filePath, MAX_PAGES);
		
		let containingTextPages = 0;
		
		for(let page of json.pages) {
			if(page[2].length) {
				containingTextPages++;
			}
		}
		
		if(!containingTextPages) {
			throw new Zotero.Exception.Alert('recognizePDF.noOCR');
		}
		
		let libraryID = item.libraryID;
		
		let res = await _query(json);
		if (!res) return null;
		
		if (res.doi) {
			Zotero.debug('RecognizePDF: Getting metadata by DOI');
			let translateDOI = new Zotero.Translate.Search();
			translateDOI.setTranslator('11645bd1-0420-45c1-badb-53fb41eeb753');
			translateDOI.setSearch({'itemType': 'journalArticle', 'DOI': res.doi});
			try {
				let newItem = await _promiseTranslate(translateDOI, libraryID);
				if (!newItem.abstractNote && res.abstract) {
					newItem.setField('abstractNote', res.abstract);
				}
				newItem.saveTx();
				return newItem;
			}
			catch (e) {
				Zotero.debug('RecognizePDF: ' + e);
			}
		}
		
		if (res.isbn) {
			Zotero.debug('RecognizePDF: Getting metadata by ISBN');
			let translate = new Zotero.Translate.Search();
			translate.setSearch({'itemType': 'book', 'ISBN': res.isbn});
			try {
				let translatedItems = await translate.translate({
					libraryID: false,
					saveAttachments: false
				});
				Zotero.debug('RecognizePDF: Translated items:');
				Zotero.debug(translatedItems);
				if (translatedItems.length) {
					let newItem = new Zotero.Item;
					newItem.fromJSON(translatedItems[0]);
					newItem.libraryID = libraryID;
					if (!newItem.abstractNote && res.abstract) {
						newItem.setField('abstractNote', res.abstract);
					}
					newItem.saveTx();
					return newItem;
				}
			}
			catch (e) {
				Zotero.debug('RecognizePDF: ' + e);
			}
		}
		
		if (res.title) {
			
			let type = 'journalArticle';
			
			if (res.type === 'book-chapter') {
				type = 'bookSection';
			}
			
			let newItem = new Zotero.Item(type);
			newItem.setField('title', res.title);
			
			let creators = [];
			for (let author of res.authors) {
				creators.push({
					firstName: author.firstName,
					lastName: author.lastName,
					creatorType: 'author'
				})
			}
			
			newItem.setCreators(creators);
			
			if (res.abstract) newItem.setField('abstractNote', res.abstract);
			if (res.year) newItem.setField('date', res.year);
			if (res.pages) newItem.setField('pages', res.pages);
			if (res.volume) newItem.setField('volume', res.volume);
			if (res.url) newItem.setField('url', res.url);
			
			if (type === 'journalArticle') {
				if (res.issue) newItem.setField('issue', res.issue);
				if (res.ISSN) newItem.setField('issn', res.issn);
				if (res.container) newItem.setField('publicationTitle', res.container);
			}
			else if (type === 'bookSection') {
				if (res.container) newItem.setField('bookTitle', res.container);
				if (res.publisher) newItem.setField('publisher', res.publisher);
			}
			
			newItem.setField('libraryCatalog', 'Zotero');
			
			await newItem.saveTx();
			return newItem;
		}
		
		return null;
	}
};

